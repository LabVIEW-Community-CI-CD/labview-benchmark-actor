#!/usr/bin/env node
// mprr zero-copy short-packet RING absorbed into labview-benchmark-actor (operator direction: "absorb mprr on
// the extension so ... any of you can leverage deterministic screenshots ... to compare both results", and
// "use the +2TB drive for storing data from the ring buffer ... to compare against windows benchmark").
//
// This is a FAITHFUL, dependency-free ESM mirror of mprr's Windows zero-copy rolling-block ring IP
// (mprr tools/review-capture-windows-zero-copy-ring, MPRR-REQ-094 / 104-119). The real mprr ring is a pagefile
// section double-mapped 2x contiguous (VirtualAlloc2/MapViewOfFile3/WaitOnAddress) -- Windows-only. This TS/JS
// mirror is the portable equivalent the contract prescribes: ONE preallocated Uint8Array + split-copy on wrap;
// a contiguous read returns a subarray VIEW (zero-copy), a wrap-spanning read is ONE copy. No per-packet alloc
// in the hot path => determinism. It gives BOTH planes (LINUX here, WIN on Windows-native) a shared, testable
// short-packet timing model so a benchmark run on either plane is comparable through the benchmark store.
//
// Timing authority: 64-bit monotonic 100ns ticks (timingTicks64). 1 tick = 100ns; TICKS_PER_MS = 10_000.
// Rolling THREE-logical-block horizon over the continuous ring; blockId = floor(timingTicks64 / blockDurTicks).

function assert(cond, msg) {
  if (!cond) {
    throw new Error(msg);
  }
}

export const MPRR_RING_SCHEMA = 'labview-benchmark-actor/mprr-short-ring@v1';

// 100ns monotonic timing authority (mprr-self-test-synthetic-monotonic-100ns).
export const TICKS_PER_MS = 10_000n;
// Default rolling-block duration: 45_000 ms (MPRR-REQ-106) => 450_000_000 ticks.
export const DEFAULT_BLOCK_DURATION_MS = 45_000;
export const DEFAULT_BLOCK_DURATION_TICKS = BigInt(DEFAULT_BLOCK_DURATION_MS) * TICKS_PER_MS;
// Admission-control capacity (MPRR-REQ-110): 10% headroom over the worst sliding 3-block byte sum.
export const ADMISSION_CAPACITY_HEADROOM = 1.1;
export const MIN_CAPACITY_BYTES = 4096;
export const CLI_DEFAULT_CAPACITY_BYTES = 58_000;
// Block-boundary variation gates (MPRR-REQ-106): authoritative <= 5.0 pct; normal-load target <= 1.0 pct.
export const AUTHORITATIVE_BOUNDARY_VARIATION_PCT = 5.0;
export const NORMAL_LOAD_BOUNDARY_VARIATION_PCT = 1.0;

/** Normalize number|bigint|string tick inputs to BigInt (timingTicks64 is 64-bit). */
export function toTicks(v) {
  if (typeof v === 'bigint') {
    return v;
  }
  if (typeof v === 'number') {
    assert(Number.isInteger(v), 'timingTicks64 must be an integer');
    return BigInt(v);
  }
  if (typeof v === 'string' && v.length > 0) {
    return BigInt(v);
  }
  throw new Error(`cannot convert to ticks: ${typeof v}`);
}

/**
 * Create an SPSC zero-copy short ring (MPRR-REQ-105) over a single preallocated buffer. Absolute monotonic byte
 * offsets: headReserved (producer), headPublished (consumer-visible), tailConsumed (released). used =
 * headPublished - tailConsumed. wrap when (startOffset % cap) + len > cap. The short stream is PROTECTED
 * (MPRR-REQ-094/110): a write that would overwrite still-unconsumed bytes fails closed rather than dropping or
 * overwriting short-packet continuity (the real ring blocks the producer on tailConsumed; JS is single-threaded
 * so we surface the same invariant as a fail-closed error).
 */
export function createShortRing(capacityBytes) {
  assert(Number.isInteger(capacityBytes) && capacityBytes >= MIN_CAPACITY_BYTES,
    `capacityBytes must be an integer >= ${MIN_CAPACITY_BYTES}`);
  const cap = capacityBytes;
  const buf = new Uint8Array(cap);
  let headReserved = 0;
  let headPublished = 0;
  let tailConsumed = 0;

  function write(payload) {
    const len = payload.length;
    assert(len > 0, 'payload must be non-empty');
    assert(len <= cap, 'payload larger than ring capacity');
    // Preserve short-packet continuity: never overwrite unconsumed bytes (fail closed).
    if ((headReserved - tailConsumed) + len > cap) {
      throw new Error('short-ring-overwrite-blocked');
    }
    const startOff = headReserved;
    const physStart = startOff % cap;
    const wrapOccurred = physStart + len > cap;
    if (wrapOccurred) {
      const first = cap - physStart;
      buf.set(payload.subarray(0, first), physStart);
      buf.set(payload.subarray(first), 0);
    } else {
      buf.set(payload, physStart);
    }
    headReserved += len;
    headPublished = headReserved; // publish AFTER the copy (Interlocked in the real ring)
    return { absoluteStartOffset: startOff, absoluteEndOffset: headReserved, wrapOccurred };
  }

  function advanceTail(absOffset) {
    assert(absOffset >= tailConsumed && absOffset <= headPublished, 'advanceTail out of published range');
    tailConsumed = absOffset;
  }

  /** Read [start, start+len): contiguous => subarray VIEW (zero-copy); wrap-spanning => one copy. */
  function copyAbsoluteRange(start, len) {
    assert(start >= tailConsumed && start + len <= headPublished, 'range not published / already consumed');
    const physStart = start % cap;
    if (physStart + len <= cap) {
      return buf.subarray(physStart, physStart + len);
    }
    const out = new Uint8Array(len);
    const first = cap - physStart;
    out.set(buf.subarray(physStart, cap), 0);
    out.set(buf.subarray(0, len - first), first);
    return out;
  }

  return {
    capacityBytes: cap,
    write,
    advanceTail,
    copyAbsoluteRange,
    state: () => ({
      headReserved,
      headPublished,
      tailConsumed,
      used: headPublished - tailConsumed,
      free: cap - (headReserved - tailConsumed),
    }),
  };
}

/** blockId = floor(timingTicks64 / blockDurationTicks) (MPRR-REQ-106). */
export function blockIdForTicks(timingTicks64, blockDurationTicks = DEFAULT_BLOCK_DURATION_TICKS) {
  const t = toTicks(timingTicks64);
  const d = toTicks(blockDurationTicks);
  assert(d > 0n, 'blockDurationTicks must be > 0');
  assert(t >= 0n, 'timingTicks64 must be >= 0');
  return t / d;
}

/** Block-boundary variation percent: |(endTick-startTick) - expectedDurationTicks| / expected * 100. */
export function boundaryVariationPct(startTick, endTick, expectedDurationTicks) {
  const s = toTicks(startTick);
  const e = toTicks(endTick);
  const exp = toTicks(expectedDurationTicks);
  assert(exp > 0n, 'expectedDurationTicks must be > 0');
  let delta = (e - s) - exp;
  if (delta < 0n) {
    delta = -delta;
  }
  // delta and exp are single-block magnitudes (< 2^53), so Number division is exact enough here.
  return (Number(delta) / Number(exp)) * 100;
}

/**
 * Required ring capacity for the rolling 3-block horizon (MPRR-REQ-110): 10% headroom over the worst sum of any
 * 3 consecutive blocks' bytes. Floors to MIN_CAPACITY_BYTES.
 */
export function requiredThreeBlockCapacityBytes(bytesPerBlock) {
  assert(Array.isArray(bytesPerBlock), 'bytesPerBlock must be an array');
  let maxSum = 0;
  for (let i = 0; i < bytesPerBlock.length; i += 1) {
    const a = bytesPerBlock[i] || 0;
    const b = bytesPerBlock[i + 1] || 0;
    const c = bytesPerBlock[i + 2] || 0;
    maxSum = Math.max(maxSum, a + b + c);
  }
  return Math.max(MIN_CAPACITY_BYTES, Math.ceil(ADMISSION_CAPACITY_HEADROOM * maxSum));
}

/** Admission control: fail closed (admission-control-blocked) when the ring is too small for the 3-block need. */
export function checkAdmission(alignedCapacityBytes, bytesPerBlock) {
  const required = requiredThreeBlockCapacityBytes(bytesPerBlock);
  const admitted = alignedCapacityBytes >= required;
  return {
    admitted,
    required,
    alignedCapacityBytes,
    outcome: admitted ? 'admitted' : 'admission-control-blocked',
  };
}

/**
 * Ingest a monotonic short-packet timing sequence into the ring and PROJECT it to a viewer-renderable metric
 * series + a benchmark-store-registerable summary. Each packet is { timingTicks64, bytes }. The series carries
 * per-packet interval + cumulative bytes + blockId (what the viewer plots); blocks[] carries per-block bytes +
 * boundary-variation authority; admission carries the fail-closed capacity verdict. Deterministic: identical
 * input => byte-identical output, which is what makes the cross-plane + screenshot comparison meaningful.
 */
export function ingestShortPackets(packets, opts = {}) {
  assert(Array.isArray(packets) && packets.length > 0, 'packets required (non-empty)');
  const blockDurationTicks = toTicks(opts.blockDurationTicks ?? DEFAULT_BLOCK_DURATION_TICKS);
  const capacityBytes = opts.capacityBytes ?? CLI_DEFAULT_CAPACITY_BYTES;
  const ring = createShortRing(capacityBytes);

  const series = [];
  const blockOrder = [];
  const blockMap = new Map(); // blockId string -> { blockId, firstTick, lastTick, bytes, packets }
  let prevTicks = null;
  let cumulativeBytes = 0;

  for (let i = 0; i < packets.length; i += 1) {
    const p = packets[i];
    const ticks = toTicks(p.timingTicks64);
    const bytes = Number(p.bytes) | 0;
    assert(bytes > 0, `packet[${i}].bytes must be > 0`);
    assert(prevTicks === null || ticks >= prevTicks, `packet[${i}] timingTicks64 not monotonic`);

    const blockId = (ticks / blockDurationTicks).toString();
    const intervalTicks = prevTicks === null ? 0n : ticks - prevTicks;

    // Model steady SPSC consumption: write the packet, then release everything up to this write's start so the
    // short stream stays continuous without unbounded growth (keeps at most the newest packet in flight).
    const w = ring.write(new Uint8Array(bytes));
    ring.advanceTail(w.absoluteStartOffset);

    cumulativeBytes += bytes;
    if (!blockMap.has(blockId)) {
      blockMap.set(blockId, { blockId, firstTick: ticks, lastTick: ticks, bytes: 0, packets: 0 });
      blockOrder.push(blockId);
    }
    const blk = blockMap.get(blockId);
    blk.lastTick = ticks;
    blk.bytes += bytes;
    blk.packets += 1;

    series.push({
      i,
      timingTicks64: ticks.toString(),
      tMs: Number(ticks) / Number(TICKS_PER_MS),
      blockId,
      intervalTicks: intervalTicks.toString(),
      intervalMs: Number(intervalTicks) / Number(TICKS_PER_MS),
      bytes,
      cumulativeBytes,
      absoluteEndOffset: w.absoluteEndOffset,
      wrapOccurred: w.wrapOccurred,
    });
    prevTicks = ticks;
  }

  // Per-block boundary variation: a block's realized clock span is the gap between its first tick and the next
  // block's first tick; compare against the expected block duration. The final block has no successor => the
  // span is not yet sealed (incomplete), which mirrors the rolling-horizon "current/reserved-next" pinning.
  const blocks = blockOrder.map((id, idx) => {
    const blk = blockMap.get(id);
    const nextId = blockOrder[idx + 1];
    let boundaryVariationPctValue = null;
    let sealed = false;
    if (nextId !== undefined) {
      const spanStart = blk.firstTick;
      const spanEnd = blockMap.get(nextId).firstTick;
      boundaryVariationPctValue = boundaryVariationPct(spanStart, spanEnd, blockDurationTicks);
      sealed = true;
    }
    return {
      blockId: id,
      firstTick: blk.firstTick.toString(),
      lastTick: blk.lastTick.toString(),
      bytes: blk.bytes,
      packets: blk.packets,
      sealed,
      boundaryVariationPct: boundaryVariationPctValue,
      withinAuthoritative:
        boundaryVariationPctValue === null ? null : boundaryVariationPctValue <= AUTHORITATIVE_BOUNDARY_VARIATION_PCT,
    };
  });

  const bytesPerBlock = blockOrder.map((id) => blockMap.get(id).bytes);
  const admission = checkAdmission(capacityBytes, bytesPerBlock);
  const sealedBlocks = blocks.filter((b) => b.sealed);
  const worstBoundaryVariationPct = sealedBlocks.length
    ? Math.max(...sealedBlocks.map((b) => b.boundaryVariationPct))
    : null;

  return {
    schema: MPRR_RING_SCHEMA,
    blockDurationTicks: blockDurationTicks.toString(),
    capacityBytes,
    packetCount: packets.length,
    totalBytes: cumulativeBytes,
    blockCount: blocks.length,
    worstBoundaryVariationPct,
    authoritative: admission.admitted
      && (worstBoundaryVariationPct === null || worstBoundaryVariationPct <= AUTHORITATIVE_BOUNDARY_VARIATION_PCT),
    admission,
    ringState: ring.state(),
    blocks,
    series,
  };
}
