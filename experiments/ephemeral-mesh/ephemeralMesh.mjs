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

  // --- lifecycle: golden -> linked clone -> ... -> destroyed (cattle, no reboot-survival) ---
  const lc = receipt.lifecycle;
  assert(lc && typeof lc === 'object', 'lifecycle must be an object');
  assert(isNonEmptyString(lc.goldenVm), 'lifecycle.goldenVm must be set');
  assert(isNonEmptyString(lc.goldenSnapshot), 'lifecycle.goldenSnapshot must be set');
  assert(isNonEmptyString(lc.cloneVm), 'lifecycle.cloneVm must be set');
  assert(lc.cloneType === 'linked', `lifecycle.cloneType must be "linked", got ${lc.cloneType}`);
  assert(Number.isFinite(lc.bootSeconds) && lc.bootSeconds > 0, 'lifecycle.bootSeconds must be a positive number');
  assert(lc.survivesReboot === false, 'lifecycle.survivesReboot must be false (the node is disposable by design)');
  assert(lc.destroyed === true, 'lifecycle.destroyed must be true (the clone must be torn down -- cattle, not pets)');

  // --- node identity proven while it was alive ---
  const node = receipt.node;
  assert(node && typeof node === 'object', 'node must be an object');
  assert(isNonEmptyString(node.hostname), 'node.hostname must be set');
  assert(isNonEmptyString(node.user), 'node.user must be set');
  assert(isNonEmptyString(node.lbabusVersion), 'node.lbabusVersion must be set');

  // --- the lbabus TCP+UDP loopback MESH OK the ephemeral node produced ---
  const m = receipt.loopbackMesh;
  assert(m && typeof m === 'object', 'loopbackMesh must be an object');
  assert(Number.isInteger(m.tcpFramesReceived) && m.tcpFramesReceived >= 1, 'loopbackMesh.tcpFramesReceived must be >= 1');
  assert(Number.isInteger(m.udpDistinctSenders) && m.udpDistinctSenders >= 1, 'loopbackMesh.udpDistinctSenders must be >= 1');
  assert(m.meshOk === true, 'loopbackMesh.meshOk must be true');

  // --- fail-closed gates ---
  const a = receipt.asserts;
  assert(a && typeof a === 'object', 'asserts must be an object');
  for (const key of [
    'sshKeyAuthNoPassword', 'lbabusPresent', 'tcpLoopback', 'udpLoopback',
    'meshOk', 'cloneCreated', 'cloneDestroyed', 'commsOnly', 'noRebootSurvivalNeeded',
  ]) {
    assert(a[key] === true, `asserts.${key} must be true`);
  }

  assert(receipt.pass === true, 'pass must be true');

  return {
    plane: receipt.plane,
    hypervisor: receipt.hypervisor,
    cloneVm: lc.cloneVm,
    goldenSnapshot: lc.goldenSnapshot,
    bootSeconds: lc.bootSeconds,
    lbabusVersion: node.lbabusVersion,
    tcpFrames: m.tcpFramesReceived,
    udpDistinct: m.udpDistinctSenders,
    meshOk: m.meshOk,
    destroyed: lc.destroyed,
  };
}
