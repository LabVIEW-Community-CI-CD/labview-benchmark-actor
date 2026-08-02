#!/usr/bin/env node
// mesh-loopback-proof.mjs -- LIVE loopback proof of the ACG mesh verdict beacon (ADR-0019, LBA-REQ-028).
//
// Beacons the REAL committed {codespace, host} witness verdicts over the ACTUAL lbabus `bus-msg@1` wire (127.0.0.1
// TCP, 4-byte length-prefixed frames via the shared busFrame), collects them in a mesh ledger, and runs the quorum
// over the resolved bundles -- writing mesh-loopback-receipt.json. This is the single-node (loopback) live proof;
// the same mechanism scales to a multi-node / multi-VM mesh (cf. the provider-delegation loopback->VM progression).
// NOT a CI gate (real sockets); the deterministic engine is gated by verify-local-gates (acg-mesh-verdict-beacon).

import net from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFrameDecoder, sendFrame } from '../provider-delegation/busFrame.mjs';
import { buildVerdictBeacon, MeshLedger, quorumFromLedger } from './verdict-beacon.mjs';
import { bundleDigest } from '../acg-provenance/attest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(repo, p), 'utf8'));

const codespace = readJson('experiments/acg-quorum/witnesses/codespace.bundle.json');
const host = readJson('experiments/acg-quorum/witnesses/host-linux.bundle.json');
const bundlesByDigest = { [bundleDigest(codespace)]: codespace, [bundleDigest(host)]: host };

const witnessNotice = (identity, bundle) => ({
  identity,
  plane: bundle.plane,
  os: bundle.os,
  verdict: bundle.gate.verdict,
  digest: bundleDigest(bundle),
  seriesHash: bundle.screenshot.seriesHash,
  sourceCommit: bundle.gate.lbabus.sourceCommit,
});
const witnesses = [witnessNotice('acg-witness:codespace', codespace), witnessNotice('acg-witness:host-linux', host)];

const ledger = new MeshLedger();
const server = net.createServer((sock) => {
  const feed = createFrameDecoder((env) => ledger.record(env), (e) => console.error('decode error:', e.message));
  sock.on('data', feed);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`mesh observer listening on 127.0.0.1:${port}`);

for (let i = 0; i < witnesses.length; i += 1) {
  const res = await sendFrame({ host: '127.0.0.1', port, envelope: buildVerdictBeacon(witnesses[i], { seq: i + 1 }) });
  console.log(`beacon ${witnesses[i].identity}: sent=${res.sent}`);
}

await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (ledger.witnesses().length >= witnesses.length) { clearInterval(iv); resolve(); }
    else if (Date.now() - t0 > 5000) { clearInterval(iv); reject(new Error('timeout waiting for beacons')); }
  }, 50);
});

const meshQuorum = quorumFromLedger(ledger, { bundlesByDigest });
const receipt = {
  schema: 'labview-benchmark-actor/acg-mesh-loopback-receipt-v1',
  transport: 'lbabus bus-msg@1 (ADR-0003) over loopback 127.0.0.1 TCP',
  producedAt: new Date().toISOString(),
  beaconed: ledger.witnesses().map((w) => w.witnessIdentity).sort(),
  ledgerHash: ledger.ledgerHash(),
  meshQuorum,
};
writeFileSync(join(here, 'mesh-loopback-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
server.close();
console.log(`mesh loopback: beaconed=${meshQuorum.beaconed} resolved=${meshQuorum.resolved} quorum=${meshQuorum.quorum.verdict} confidence=${meshQuorum.quorum.confidence?.toFixed?.(3) ?? meshQuorum.quorum.confidence}`);
console.log('wrote experiments/acg-mesh/mesh-loopback-receipt.json');
