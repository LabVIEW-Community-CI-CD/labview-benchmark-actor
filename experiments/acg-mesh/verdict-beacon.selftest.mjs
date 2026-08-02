#!/usr/bin/env node
// verdict-beacon.selftest.mjs -- dependency-free self-test for the ACG mesh verdict beacon + ledger (LBA-REQ-028).
// Proves a witness verdict beacons as a valid bus-msg@1 NOTE, survives the real 4-byte-framed wire round-trip,
// fails closed on malformed frames, and that the mesh ledger dedups + feeds the quorum end to end.

import assert from 'node:assert/strict';
import { buildVerdictBeacon, parseVerdictBeacon, MeshLedger, quorumFromLedger, VERDICT_TASK } from './verdict-beacon.mjs';
import { encodeFrame, createFrameDecoder, BUS_SCHEMA } from '../provider-delegation/busFrame.mjs';
import { bundleDigest } from '../acg-provenance/attest.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

const mkBundle = (plane, o = {}) => ({
  schema: 'labview-benchmark-actor/acg-witness-bundle-v1',
  plane,
  os: o.os ?? 'linux',
  gate: { verdict: o.verdict ?? 'pass', lbabus: { version: o.version ?? '0.13.0', sourceCommit: o.sourceCommit ?? 'c0ffee1' } },
  screenshot: { seriesHash: o.seriesHash ?? 'ser-shared', pngSha256: o.pngSha256 ?? 'png-linux' },
  ubuntu: (o.os ?? 'linux') === 'linux' ? (o.ubuntu ?? 'noble') : null,
});
const witnessOf = (plane, bundle) => ({ identity: `acg-witness:${plane.toLowerCase()}`, plane, os: bundle.os, verdict: bundle.gate.verdict, digest: bundleDigest(bundle), seriesHash: bundle.screenshot.seriesHash, sourceCommit: bundle.gate.lbabus.sourceCommit });

// 1. A verdict beacon is a valid bus-msg@1 NOTE with the verdict task + payload.
ok('buildVerdictBeacon produces a bus-msg@1 verdict NOTE', () => {
  const b = buildVerdictBeacon({ identity: 'acg-witness:codespace', plane: 'CODESPACE', os: 'linux', verdict: 'pass', digest: 'deadbeef' }, { seq: 1 });
  assert.equal(b.schema, BUS_SCHEMA);
  assert.equal(b.type, 'NOTE');
  assert.equal(b.task, VERDICT_TASK);
  assert.equal(b.senderId, 'acg-witness:codespace');
  assert.equal(b.payload.digest, 'deadbeef');
});

// 2. build -> parse round-trip.
ok('parseVerdictBeacon round-trips the notice', () => {
  const b = buildVerdictBeacon({ identity: 'acg-witness:vbox', plane: 'VBOX', os: 'linux', verdict: 'pass', digest: 'abc123' }, { seq: 3 });
  const n = parseVerdictBeacon(b);
  assert.equal(n.witnessIdentity, 'acg-witness:vbox');
  assert.equal(n.verdict, 'pass');
  assert.equal(n.digest, 'abc123');
  assert.equal(n.seq, 3);
});

// 3. The beacon survives the REAL bus wire (4-byte length-prefixed framing).
ok('a beacon survives the real bus-msg@1 wire round-trip', () => {
  const b = buildVerdictBeacon({ identity: 'acg-witness:win', plane: 'WIN', os: 'windows', verdict: 'pass', digest: 'w1nd1gest' }, { seq: 2 });
  let decoded;
  const feed = createFrameDecoder((env) => { decoded = env; }, (e) => { throw e; });
  feed(encodeFrame(b));
  const n = parseVerdictBeacon(decoded);
  assert.equal(n.witnessIdentity, 'acg-witness:win');
  assert.equal(n.digest, 'w1nd1gest');
});

// 4. parseVerdictBeacon fails closed on malformed envelopes.
ok('parseVerdictBeacon fails closed', () => {
  assert.throws(() => parseVerdictBeacon({ schema: 'other', task: VERDICT_TASK, payload: {} }), /not a bus-msg@1/);
  assert.throws(() => parseVerdictBeacon({ schema: BUS_SCHEMA, task: 'CLAIM', payload: {} }), /not an acg-verdict beacon/);
  assert.throws(() => parseVerdictBeacon({ schema: BUS_SCHEMA, task: VERDICT_TASK, payload: { digest: 'x', verdict: 'pass' } }), /missing witnessIdentity/);
  assert.throws(() => parseVerdictBeacon({ schema: BUS_SCHEMA, task: VERDICT_TASK, payload: { witnessIdentity: 'w', verdict: 'pass' } }), /missing bundle digest/);
  assert.throws(() => parseVerdictBeacon({ schema: BUS_SCHEMA, task: VERDICT_TASK, payload: { witnessIdentity: 'w', digest: 'x' } }), /missing verdict/);
});

// 5. The ledger dedups by witness, keeping the highest seq and rejecting stale/replayed seqs.
ok('the ledger dedups by witness and rejects stale seqs', () => {
  const led = new MeshLedger();
  assert.equal(led.record(buildVerdictBeacon({ identity: 'w', plane: 'CODESPACE', os: 'linux', verdict: 'fail', digest: 'd1' }, { seq: 1 })).accepted, true);
  assert.equal(led.record(buildVerdictBeacon({ identity: 'w', plane: 'CODESPACE', os: 'linux', verdict: 'pass', digest: 'd2' }, { seq: 2 })).accepted, true);
  const stale = led.record(buildVerdictBeacon({ identity: 'w', plane: 'CODESPACE', os: 'linux', verdict: 'fail', digest: 'd0' }, { seq: 1 }));
  assert.equal(stale.accepted, false);
  assert.match(stale.reason, /stale seq/);
  assert.equal(led.witnesses().length, 1);
  assert.equal(led.verdicts().w, 'pass'); // the seq-2 value wins
});

// 6. The ledger hash is deterministic and advances as accepted records append.
ok('the ledger hash is tamper-evident and advances', () => {
  const a = new MeshLedger();
  const b = new MeshLedger();
  const mk = (id, seq) => buildVerdictBeacon({ identity: id, plane: 'X', os: 'linux', verdict: 'pass', digest: `dg-${id}` }, { seq });
  a.record(mk('a', 1)); a.record(mk('b', 1));
  b.record(mk('a', 1));
  const h1 = b.ledgerHash();
  b.record(mk('b', 1));
  assert.equal(a.ledgerHash(), b.ledgerHash());
  assert.notEqual(h1, b.ledgerHash());
});

// 7. END TO END: three witnesses beacon -> ledger -> quorum over the resolved bundles = pass.
ok('beacon -> ledger -> quorum corroborates end to end', () => {
  const cs = mkBundle('CODESPACE'); const vbox = mkBundle('VBOX'); const win = mkBundle('WIN', { os: 'windows', pngSha256: 'png-win' });
  const witnesses = [witnessOf('CODESPACE', cs), witnessOf('VBOX', vbox), witnessOf('WIN', win)];
  const led = new MeshLedger();
  witnesses.forEach((w, i) => assert.equal(led.record(buildVerdictBeacon(w, { seq: i + 1 })).accepted, true));
  const bundlesByDigest = { [bundleDigest(cs)]: cs, [bundleDigest(vbox)]: vbox, [bundleDigest(win)]: win };
  const out = quorumFromLedger(led, { bundlesByDigest });
  assert.equal(out.beaconed, 3);
  assert.equal(out.resolved, 3);
  assert.equal(out.quorum.verdict, 'pass');
  assert.equal(out.missing.length, 0);
  assert.equal(out.mismatched.length, 0);
});

// 8. quorumFromLedger fails closed on a missing bundle or a digest that does not match its bundle.
ok('quorumFromLedger fails closed on missing / mismatched bundles', () => {
  const cs = mkBundle('CODESPACE'); const vbox = mkBundle('VBOX');
  const led = new MeshLedger();
  led.record(buildVerdictBeacon(witnessOf('CODESPACE', cs), { seq: 1 }));
  led.record(buildVerdictBeacon(witnessOf('VBOX', vbox), { seq: 2 }));
  // Only the codespace bundle is available; the vbox digest resolves to a DIFFERENT bundle (mismatch).
  const missingOut = quorumFromLedger(led, { bundlesByDigest: { [bundleDigest(cs)]: cs } });
  assert.equal(missingOut.missing.length, 1);
  assert.equal(missingOut.quorum.verdict, 'error'); // fewer than two resolved
  const mismatchOut = quorumFromLedger(led, { bundlesByDigest: { [bundleDigest(cs)]: cs, [witnessOf('VBOX', vbox).digest]: mkBundle('VBOX', { sourceCommit: 'tampered' }) } });
  assert.equal(mismatchOut.mismatched.length, 1);
});

console.log(`verdict-beacon self-test: ${pass}/${pass} PASS`);
