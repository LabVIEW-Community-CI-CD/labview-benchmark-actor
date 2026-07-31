// ephemeralMesh.mjs -- schema + offline validator for the canonical ephemeral-mesh receipt (ephemeral-mesh@1).
//
// Dependency-free ESM (Node >= 18). Shared by the LIVE runner (run-ephemeral-mesh.mjs, which produces the
// receipt on a VBox host) and the OFFLINE gate (verify-ephemeral-mesh.mjs + verify-local-gates.mjs, which
// re-validate the committed receipt on any runner with no VM). This split is the repo pattern: a live
// experiment seals a receipt; a portable validator re-proves it fails-closed on every PR.
//
// The receipt attests ONE turn of the cattle lifecycle -- golden snapshot -> linked clone -> boot -> run ->
// DESTROY -- plus the lbabus TCP+UDP loopback MESH OK the ephemeral node proved while it was alive
// (LBA-REQ-006 declarative topology + clean teardown, LBA-REQ-007 comms-only bus, ADR-0003/0004).

export const EPHEMERAL_MESH_SCHEMA = 'labview-benchmark-actor/ephemeral-mesh-receipt-v1';
export const EPHEMERAL_MESH_CONCEPT = 'ephemeral-mesh@1';
export const EPHEMERAL_MESH_PLANES = Object.freeze(['LINUX', 'WINDOWS']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// Validate an ephemeral-mesh receipt object. Throws on the first violation; returns a compact summary when
// the receipt is a faithful, PASSING attestation of a full cattle cycle + a loopback MESH OK.
export function validateEphemeralMeshReceipt(receipt) {
  assert(receipt && typeof receipt === 'object', 'receipt must be an object');
  assert(receipt.schema === EPHEMERAL_MESH_SCHEMA, `schema must be ${EPHEMERAL_MESH_SCHEMA}, got ${receipt.schema}`);
  assert(receipt.concept === EPHEMERAL_MESH_CONCEPT, `concept must be ${EPHEMERAL_MESH_CONCEPT}, got ${receipt.concept}`);
  assert(EPHEMERAL_MESH_PLANES.includes(receipt.plane), `plane must be one of ${EPHEMERAL_MESH_PLANES.join('|')}, got ${receipt.plane}`);
  assert(isNonEmptyString(receipt.hypervisor), 'hypervisor must be a non-empty string');
  assert(isNonEmptyString(receipt.transport), 'transport must be a non-empty string');
  assert(isNonEmptyString(receipt.ranAt), 'ranAt must be a non-empty ISO string');

  // --- common lifecycle: golden -> linked clone(s) -> ... -> destroyed (cattle, no reboot-survival) ---
  const lc = receipt.lifecycle;
  assert(lc && typeof lc === 'object', 'lifecycle must be an object');
  assert(isNonEmptyString(lc.goldenVm), 'lifecycle.goldenVm must be set');
  assert(isNonEmptyString(lc.goldenSnapshot), 'lifecycle.goldenSnapshot must be set');
  const clones = Array.isArray(lc.cloneVms) ? lc.cloneVms : (lc.cloneVm ? [lc.cloneVm] : []);
  assert(clones.length >= 1 && clones.every(isNonEmptyString), 'lifecycle must name >= 1 clone (cloneVm or cloneVms)');
  assert(lc.cloneType === 'linked', `lifecycle.cloneType must be "linked", got ${lc.cloneType}`);
  assert(Number.isFinite(lc.bootSeconds) && lc.bootSeconds > 0, 'lifecycle.bootSeconds must be a positive number');
  assert(lc.survivesReboot === false, 'lifecycle.survivesReboot must be false (the node is disposable by design)');
  assert(lc.destroyed === true, 'lifecycle.destroyed must be true (the clone must be torn down -- cattle, not pets)');

  // --- common fail-closed gates (shared by every mesh mode) ---
  const a = receipt.asserts;
  assert(a && typeof a === 'object', 'asserts must be an object');
  for (const key of ['sshKeyAuthNoPassword', 'lbabusPresent', 'meshOk', 'cloneCreated', 'cloneDestroyed', 'commsOnly', 'noRebootSurvivalNeeded']) {
    assert(a[key] === true, `asserts.${key} must be true`);
  }
  assert(receipt.pass === true, 'pass must be true');

  // --- mode dispatch (a missing meshMode defaults to loopback, so the P1 receipt stays valid) ---
  const meshMode = receipt.meshMode ?? 'loopback';
  assert(['loopback', 'typed'].includes(meshMode), `meshMode must be loopback|typed, got ${meshMode}`);
  const modeSummary = meshMode === 'loopback' ? validateLoopbackMesh(receipt) : validateTypedMesh(receipt);
  return {
    plane: receipt.plane, hypervisor: receipt.hypervisor, meshMode, clones: clones.length,
    goldenSnapshot: lc.goldenSnapshot, bootSeconds: lc.bootSeconds, destroyed: lc.destroyed, ...modeSummary,
  };
}

// --- loopback mode (P1): one clone hears ITSELF over TCP+UDP on 127.0.0.1 ---
function validateLoopbackMesh(receipt) {
  const node = receipt.node;
  assert(node && typeof node === 'object', 'node must be an object');
  assert(isNonEmptyString(node.hostname), 'node.hostname must be set');
  assert(isNonEmptyString(node.user), 'node.user must be set');
  assert(isNonEmptyString(node.lbabusVersion), 'node.lbabusVersion must be set');
  const m = receipt.loopbackMesh;
  assert(m && typeof m === 'object', 'loopbackMesh must be an object');
  assert(Number.isInteger(m.tcpFramesReceived) && m.tcpFramesReceived >= 1, 'loopbackMesh.tcpFramesReceived must be >= 1');
  assert(Number.isInteger(m.udpDistinctSenders) && m.udpDistinctSenders >= 1, 'loopbackMesh.udpDistinctSenders must be >= 1');
  assert(m.meshOk === true, 'loopbackMesh.meshOk must be true');
  const a = receipt.asserts;
  for (const key of ['tcpLoopback', 'udpLoopback']) assert(a[key] === true, `asserts.${key} must be true`);
  return { lbabusVersion: node.lbabusVersion, tcpFrames: m.tcpFramesReceived, udpDistinct: m.udpDistinctSenders, meshOk: m.meshOk };
}

// --- typed mode (P2): source/sink/both nodes + a sink's strict-serialization ingest log (spec 4.3) ---
function validateTypedMesh(receipt) {
  assert(['serialized', 'strict-reproducible'].includes(receipt.serializationMode),
    `serializationMode must be serialized|strict-reproducible, got ${receipt.serializationMode}`);
  const nodes = receipt.nodes;
  assert(Array.isArray(nodes) && nodes.length >= 2, 'typed mesh must have >= 2 nodes');
  let sources = 0, sinks = 0, boths = 0;
  for (const n of nodes) {
    assert(isNonEmptyString(n.id), 'node.id must be set');
    assert(['source', 'sink', 'both'].includes(n.nodeType), `node ${n.id} nodeType must be source|sink|both, got ${n.nodeType}`);
    const act = n.activity;
    assert(act && typeof act === 'object', `node ${n.id} activity must be an object`);
    // types are ENFORCED, not advisory: a source must not listen, a sink must not emit coordination (spec 7).
    const wantListen = n.nodeType === 'sink' || n.nodeType === 'both';
    const wantEmit = n.nodeType === 'source' || n.nodeType === 'both';
    assert(act.listened === wantListen, `node ${n.id} (${n.nodeType}) activity.listened must be ${wantListen}`);
    assert(act.emittedCoordination === wantEmit, `node ${n.id} (${n.nodeType}) activity.emittedCoordination must be ${wantEmit}`);
    if (n.nodeType === 'source') sources += 1;
    if (n.nodeType === 'sink') { sinks += 1; validateOrderedReceipt(n); }
    if (n.nodeType === 'both') { boths += 1; validateOrderedReceipt(n); }
  }
  assert(sinks + boths >= 1, 'typed mesh must have >= 1 sink (a sink or a both)');
  assert(receipt.asserts.nodeTypesHonored === true, 'asserts.nodeTypesHonored must be true');
  assert(receipt.asserts.strictSerialization === true, 'asserts.strictSerialization must be true');
  return { serializationMode: receipt.serializationMode, nodes: nodes.length, sources, sinks, boths };
}

// --- the strict-serialization recompute (spec 4.3): re-derive the sink's ingest log fails-closed ---
function validateOrderedReceipt(node) {
  const or = node.orderedReceipt;
  assert(or && typeof or === 'object', `sink ${node.id} must have an orderedReceipt`);
  const log = or.frameLog;
  assert(Array.isArray(log) && log.length >= 1, `sink ${node.id} orderedReceipt.frameLog must be a non-empty array`);
  const M = log.length;

  // (a) the sink-assigned ingestSeq is a dense 1..M total order (no gap, no duplicate)
  const seen = new Set();
  for (const f of log) {
    assert(isNonEmptyString(f.sessionId), `sink ${node.id} frame.sessionId must be set`);
    assert(isNonEmptyString(f.senderId), `sink ${node.id} frame.senderId must be set`);
    assert(Number.isInteger(f.seq) && f.seq >= 1, `sink ${node.id} frame.seq must be an integer >= 1`);
    assert(Number.isInteger(f.ingestSeq) && f.ingestSeq >= 1 && f.ingestSeq <= M, `sink ${node.id} frame.ingestSeq must be in 1..${M}`);
    assert(['PAYLOAD', 'DONE'].includes(f.frameType), `sink ${node.id} frame.frameType must be PAYLOAD|DONE, got ${f.frameType}`);
    assert(!seen.has(f.ingestSeq), `sink ${node.id} ingestSeq ${f.ingestSeq} is duplicated (the log must be dense)`);
    seen.add(f.ingestSeq);
  }
  assert(seen.size === M, `sink ${node.id} ingestSeq must be dense 1..${M}`);
  assert(or.ingestSeqDense === true, `sink ${node.id} orderedReceipt.ingestSeqDense must be true`);
  assert(or.totalFrames === M, `sink ${node.id} orderedReceipt.totalFrames (${or.totalFrames}) must equal the frameLog length (${M})`);
  assert(or.strictSerialization === true, `sink ${node.id} orderedReceipt.strictSerialization must be true`);

  // (b) per (sessionId, senderId) stream: payloads contiguous seq 1..N in increasing ingestSeq + one terminal DONE(N)
  const streams = new Map();
  for (const f of log) {
    const key = `${f.sessionId}\u0000${f.senderId}`;
    if (!streams.has(key)) streams.set(key, []);
    streams.get(key).push(f);
  }
  assert(Array.isArray(or.perStream) && or.perStream.length === streams.size,
    `sink ${node.id} perStream count (${or.perStream?.length}) must equal the distinct stream count (${streams.size})`);
  for (const [key, frames] of streams) {
    const [sessionId, senderId] = key.split('\u0000');
    const payloads = frames.filter((f) => f.frameType === 'PAYLOAD').sort((x, y) => x.ingestSeq - y.ingestSeq);
    const dones = frames.filter((f) => f.frameType === 'DONE');
    const N = payloads.length;
    assert(N >= 1, `stream ${senderId} must carry >= 1 payload frame`);
    for (let i = 0; i < N; i += 1) {
      assert(payloads[i].seq === i + 1, `stream ${senderId} payloads must be contiguous seq 1..${N} in increasing ingestSeq (got seq ${payloads[i].seq} at position ${i + 1})`);
    }
    assert(dones.length === 1, `stream ${senderId} must have exactly one terminal DONE (got ${dones.length})`);
    assert(dones[0].seq === N, `stream ${senderId} terminal DONE seq (${dones[0].seq}) must equal N=${N}`);
    assert(dones[0].ingestSeq > payloads[N - 1].ingestSeq, `stream ${senderId} DONE must be ingested after all its payloads`);
    const sum = or.perStream.find((s) => s.sessionId === sessionId && s.senderId === senderId);
    assert(sum, `sink ${node.id} perStream is missing stream ${sessionId}/${senderId}`);
    assert(sum.firstSeq === 1 && sum.lastSeq === N && sum.count === N, `stream ${senderId} perStream first/last/count must be 1/${N}/${N}`);
    assert(sum.contiguous === true && sum.inIngestOrder === true && sum.terminalDone === true, `stream ${senderId} perStream flags must all be true`);
  }
}
