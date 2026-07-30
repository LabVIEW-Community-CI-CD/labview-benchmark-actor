#!/usr/bin/env node
// capture-ring.mjs — the SHARED ring-ingest adapter: a fixed 24-byte capture-frame packet written into and read
// back out of the mprr zero-copy short ring (experiments/mprr-ring/mprrRing.mjs). This is the cross-plane
// backbone both planes serialize against — LINUX feeds it a VirtualBox VNC frame source, WIN feeds it a VMware
// RemoteDisplay.vnc streaming source — so a capture on either plane is byte-identical on the wire and comparable
// through the benchmark store. Agreed contract (discussioncomment-17843572, task mprr-capture-ring-backbone):
//
//   * ACCESS is DataView, little-endian — NOT typed-array views. The ring is BYTE-OFFSET addressed and its
//     capacity (CLI_DEFAULT_CAPACITY_BYTES = 58_000) is not a multiple of PACKET_BYTES, so a record — and its
//     u64 fields — can land at ANY physical offset. A BigUint64Array view requires an 8-byte-aligned byteOffset
//     and would throw on an unaligned record; DataView.getBigUint64/setBigUint64 are alignment-agnostic.
//
//   * The 24-byte record is SELF-DESCRIBING: a packetVersion byte (=1) lets a future extended packet evolve
//     without silently misparsing on an old reader (this v1 reader fails closed on any other version).
//
//   * dhash64 is stored as the 64 BITS (u64), not the 16-hex string, via the single-source
//     dhashHexToBits/dhashBitsToHex helpers in fingerprint.mjs — so LINUX and WIN serialize identically and
//     hammingHex still works off a ring-decoded u64. The dhash-64 algorithm/bits are unchanged (no spec bump).
//
//   * dhash64 is OPTIONAL: a record with milestoneId > 0 and dhash64 == 0 is a PURE TIMING MARKER (no frame).
//     So ONE record builder serves BOTH the VM visual ring (dhash frames) AND the hypervisor-free container
//     milestone-only path (bootbench has no VNC) — buildMs/meshFormMs stay guest-clock in both.
//
// 24-byte little-endian layout:
//   off  0  u64  timingTicks64   monotonic 100ns ticks (mprr timing authority; TICKS_PER_MS = 10_000)
//   off  8  u32  frameIndex      producer frame counter
//   off 12  u64  dhash64         dhash-64 perceptual fingerprint as 64 bits (0 => no visual frame)
//   off 20  u8   milestoneId     MILESTONE_IDS enum (0 = none; 1..4 pinned; 5..255 workload markers)
//   off 21  u8   flags           bit0 = settled; bit1..7 reserved (bit1 = keyframe, later)
//   off 22  u8   packetVersion   = 1
//   off 23  u8   reserved        = 0

import { toTicks } from '../mprr-ring/mprrRing.mjs';
import { dhashHexToBits, dhashBitsToHex } from '../manual-procedure-record/fingerprint.mjs';

export const CAPTURE_RING_SCHEMA = 'labview-benchmark-actor/capture-ring-packet@v1';
export const PACKET_BYTES = 24;
export const PACKET_VERSION = 1;
const U32_MAX = 0xffffffff;
const U64_MAX = 0xffffffffffffffffn;

/** Little-endian field offsets within the 24-byte record (DataView access — alignment-agnostic). */
export const OFFSETS = Object.freeze({
  timingTicks64: 0, // u64
  frameIndex: 8, // u32
  dhash64: 12, // u64
  milestoneId: 20, // u8
  flags: 21, // u8
  packetVersion: 22, // u8
  reserved: 23, // u8
});

/** flags bitfield. bit0 = settled (frame is visually settled); bit1..7 reserved (bit1 = keyframe later). */
export const FLAG_SETTLED = 0b0000_0001;

/**
 * milestoneId enum — SINGLE SOURCE OF TRUTH shared by both planes. The caseIds carry the `LBABUS-` prefix for
 * BUILD-START/BUILT so a recorder reconstructs the EXACT caseIds the boot-benchmark record uses (matching the
 * LBABENCH wire markers). 0 = none (a pure visual frame, no milestone). 5..255 reserved for workload markers.
 */
export const MILESTONE_IDS = Object.freeze({
  0: null,
  1: 'BOOT-START',
  2: 'LBABUS-BUILD-START',
  3: 'LBABUS-BUILT',
  4: 'MESH-OK',
});

/** Reverse map caseId -> milestoneId, derived from MILESTONE_IDS (single source; skips the 0/none entry). */
export const MILESTONE_ID_BY_CASE = Object.freeze(
  Object.fromEntries(
    Object.entries(MILESTONE_IDS)
      .filter(([, caseId]) => caseId !== null)
      .map(([id, caseId]) => [caseId, Number(id)]),
  ),
);

/** caseId for a milestoneId: 0 -> null; 1..4 -> pinned caseId; 5..255 (workload) -> null (not pinned here). */
export function caseIdForMilestone(milestoneId) {
  return Object.prototype.hasOwnProperty.call(MILESTONE_IDS, milestoneId) ? MILESTONE_IDS[milestoneId] : null;
}

/** milestoneId for a pinned caseId; fails closed on an unknown caseId. */
export function milestoneIdForCase(caseId) {
  const id = MILESTONE_ID_BY_CASE[caseId];
  if (id === undefined) {
    throw new Error(`capture-ring: unknown milestone caseId '${caseId}'`);
  }
  return id;
}

/** Resolve the dhash u64 from a frame: dhashHex (16 hex) | dhash64 (bigint|int) | neither (=> 0n, no frame). */
function resolveDhashBits(frame) {
  const hasHex = frame.dhashHex !== undefined && frame.dhashHex !== null;
  const hasNum = frame.dhash64 !== undefined && frame.dhash64 !== null;
  if (hasHex && hasNum) {
    const fromHex = dhashHexToBits(frame.dhashHex);
    const fromNum = typeof frame.dhash64 === 'bigint' ? frame.dhash64 : BigInt(frame.dhash64);
    if (fromHex !== fromNum) {
      throw new Error('capture-ring: dhashHex and dhash64 disagree');
    }
    return fromHex;
  }
  if (hasHex) {
    return dhashHexToBits(frame.dhashHex);
  }
  if (hasNum) {
    const bits = typeof frame.dhash64 === 'bigint' ? frame.dhash64 : BigInt(frame.dhash64);
    if (bits < 0n || bits > U64_MAX) {
      throw new Error('capture-ring: dhash64 out of u64 range');
    }
    return bits;
  }
  return 0n;
}

/** Resolve the milestoneId from a frame: caseId (pinned) | milestoneId (u8) | neither (=> 0, none). */
function resolveMilestoneId(frame) {
  const hasCase = frame.caseId !== undefined && frame.caseId !== null;
  if (hasCase) {
    const id = milestoneIdForCase(frame.caseId);
    if (frame.milestoneId !== undefined && frame.milestoneId !== null && frame.milestoneId !== id) {
      throw new Error(`capture-ring: milestoneId ${frame.milestoneId} disagrees with caseId '${frame.caseId}' (${id})`);
    }
    return id;
  }
  if (frame.milestoneId !== undefined && frame.milestoneId !== null) {
    const id = frame.milestoneId;
    if (!Number.isInteger(id) || id < 0 || id > 255) {
      throw new Error('capture-ring: milestoneId must be a u8 (0..255)');
    }
    return id;
  }
  return 0;
}

/** Resolve the flags byte from a frame: raw `flags` u8 (optional) with `settled` bool setting/clearing bit0. */
function resolveFlags(frame) {
  let flags = 0;
  if (frame.flags !== undefined && frame.flags !== null) {
    if (!Number.isInteger(frame.flags) || frame.flags < 0 || frame.flags > 255) {
      throw new Error('capture-ring: flags must be a u8 (0..255)');
    }
    flags = frame.flags;
  }
  if (frame.settled === true) {
    flags |= FLAG_SETTLED;
  } else if (frame.settled === false) {
    flags &= ~FLAG_SETTLED;
  }
  return flags & 0xff;
}

/**
 * Encode a capture frame into a fresh 24-byte Uint8Array (little-endian, DataView). Accepts:
 *   timingTicks64: number|bigint|string  (monotonic 100ns ticks)
 *   frameIndex:    u32                    (default 0)
 *   dhashHex:      16 hex chars  OR  dhash64: bigint|int   (optional; omitted => 0 => no visual frame)
 *   caseId:        pinned caseId  OR  milestoneId: u8      (optional; omitted => 0 => none)
 *   settled:       boolean (sets flags bit0)  and/or  flags: raw u8
 * A record MUST carry a visual frame (dhash64 != 0) AND/OR a milestone (milestoneId > 0) — an empty record
 * fails closed (the same fail-closed discipline the ring itself uses).
 */
export function encodeCaptureFrame(frame) {
  if (!frame || typeof frame !== 'object') {
    throw new Error('capture-ring: frame object required');
  }
  const timingTicks64 = toTicks(frame.timingTicks64 ?? 0);
  if (timingTicks64 < 0n || timingTicks64 > U64_MAX) {
    throw new Error('capture-ring: timingTicks64 out of u64 range');
  }
  const frameIndex = frame.frameIndex ?? 0;
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex > U32_MAX) {
    throw new Error('capture-ring: frameIndex must be a u32 (0..4294967295)');
  }
  const dhash64 = resolveDhashBits(frame);
  const milestoneId = resolveMilestoneId(frame);
  const flags = resolveFlags(frame);
  if (dhash64 === 0n && milestoneId === 0) {
    throw new Error('capture-ring: empty frame — set dhash64/dhashHex (visual) and/or milestoneId/caseId (timing marker)');
  }

  const buf = new Uint8Array(PACKET_BYTES);
  const dv = new DataView(buf.buffer, buf.byteOffset, PACKET_BYTES);
  dv.setBigUint64(OFFSETS.timingTicks64, timingTicks64, true);
  dv.setUint32(OFFSETS.frameIndex, frameIndex, true);
  dv.setBigUint64(OFFSETS.dhash64, dhash64, true);
  dv.setUint8(OFFSETS.milestoneId, milestoneId);
  dv.setUint8(OFFSETS.flags, flags);
  dv.setUint8(OFFSETS.packetVersion, PACKET_VERSION);
  dv.setUint8(OFFSETS.reserved, 0);
  return buf;
}

/**
 * Decode a 24-byte record (a subarray VIEW from the ring, possibly at an unaligned physical offset, OR a
 * one-copy Uint8Array on wrap) back into a frame object. DataView reads are alignment-agnostic, so this works
 * whatever physical offset the record landed at. Fails closed on an unsupported packetVersion.
 */
export function decodeCaptureFrame(bytes) {
  if (!ArrayBuffer.isView(bytes) || bytes.byteLength < PACKET_BYTES) {
    throw new Error(`capture-ring: need a >= ${PACKET_BYTES}-byte view to decode`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, PACKET_BYTES);
  const packetVersion = dv.getUint8(OFFSETS.packetVersion);
  if (packetVersion !== PACKET_VERSION) {
    throw new Error(`capture-ring: unsupported packetVersion ${packetVersion} (this reader is v${PACKET_VERSION})`);
  }
  const dhash64 = dv.getBigUint64(OFFSETS.dhash64, true);
  const milestoneId = dv.getUint8(OFFSETS.milestoneId);
  const flags = dv.getUint8(OFFSETS.flags);
  return {
    timingTicks64: dv.getBigUint64(OFFSETS.timingTicks64, true),
    frameIndex: dv.getUint32(OFFSETS.frameIndex, true),
    dhash64,
    dhashHex: dhashBitsToHex(dhash64),
    milestoneId,
    caseId: caseIdForMilestone(milestoneId),
    settled: (flags & FLAG_SETTLED) !== 0,
    flags,
    packetVersion,
    hasFrame: dhash64 !== 0n,
  };
}

/**
 * PRODUCER: encode a capture frame and write it into the ring. Returns the ring's write result
 * ({ absoluteStartOffset, absoluteEndOffset, wrapOccurred }). The ring fails closed
 * ('short-ring-overwrite-blocked') if the write would overwrite still-unconsumed bytes.
 */
export function writeCaptureFrame(ring, frame) {
  const payload = encodeCaptureFrame(frame);
  return ring.write(payload);
}

/**
 * CONSUMER (recorder-as-consumer): read whole 24-byte records back out of the ring across the absolute byte
 * range [fromOffset, toOffset) and decode each. The span MUST be a whole number of PACKET_BYTES records (fails
 * closed otherwise). Each decoded frame carries `hasFrame` (dhash64 != 0) and `caseId` so ONE recorder can
 * build either a visual-frame record (hasFrame) or a milestone-only timing stream (milestoneId > 0, no frame).
 */
export function readCaptureFrames(ring, fromOffset, toOffset) {
  if (!Number.isInteger(fromOffset) || !Number.isInteger(toOffset) || toOffset < fromOffset) {
    throw new Error('capture-ring: an integer [fromOffset, toOffset) range is required');
  }
  const span = toOffset - fromOffset;
  if (span % PACKET_BYTES !== 0) {
    throw new Error(`capture-ring: byte span ${span} is not a whole number of ${PACKET_BYTES}-byte records`);
  }
  const frames = [];
  for (let off = fromOffset; off < toOffset; off += PACKET_BYTES) {
    const slice = ring.copyAbsoluteRange(off, PACKET_BYTES);
    frames.push(decodeCaptureFrame(slice));
  }
  return frames;
}
