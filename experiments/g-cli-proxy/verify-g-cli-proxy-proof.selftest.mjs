#!/usr/bin/env node
// Self-test for gcliProxyBenchmark.mjs (LBA-REQ-052, realizes ADR-0033). Binds the committed g-cli-proxy
// proof receipt (the Linux g-cli launcher built FROM RUST SOURCE, then driving host LabVIEW 2026 through a
// full TCP round-trip: launch Echo Parameters.vi -> echo the args back -> exit 0). Proves the receipt
// validates + is deterministic + the resultHash is machine-independent (build-time / toolchain / install-path
// invariant), and FAILS CLOSED on a tampered resultHash, a forged verdict, an echo that does not match the
// args sent, or a tampered digest. Pure -- no Rust / g-cli / LabVIEW.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildGcliReceipt, validateGcliReceipt, computeResultHash, digestReceipt, RECEIPT_SCHEMA,
} from './gcliProxyBenchmark.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const committed = JSON.parse(readFileSync(join(here, 'fixtures', 'g-cli-proxy-proof-receipt.json'), 'utf8'));

let n = 0;
const ok = (m) => { n++; console.log(`ok ${n} - ${m}`); };

// re-usable capture derived from the committed receipt
const captureOf = (r) => ({
  plane: r.plane, host: r.host, tool: r.tool, version: r.version, source: r.source, toolchain: r.toolchain,
  operation: r.operation, launchTargetVi: r.launchTargetVi, labview: r.labview, detectedInstall: r.detectedInstall,
  argsIn: r.argsIn, echoedText: r.echoedText, exitCode: r.exitCode,
  buildSeconds: r.timing?.buildSeconds, roundTripSeconds: r.timing?.roundTripSeconds, note: r.note,
});

// 1. the committed receipt validates and the proof passed
{
  const v = validateGcliReceipt(committed);
  assert.ok(v.ok && v.proofOk, `committed receipt must validate + pass: ${v.findings.join('; ')}`);
  assert.equal(committed.schema, RECEIPT_SCHEMA, 'schema is g-cli-proxy-proof@1');
  assert.equal(committed.tool, 'g-cli', 'tool is g-cli');
  assert.equal(committed.exitCode, 0, 'LabVIEW exited 0');
  assert.equal(committed.roundTripEchoed, true, 'the round-trip echoed the args');
  ok('committed g-cli-proxy-proof receipt validates and the round-trip passed');
}

// 2. deterministic: the same capture rebuilds byte-identically
{
  const a = buildGcliReceipt(captureOf(committed));
  const b = buildGcliReceipt(captureOf(committed));
  assert.equal(a.digest, b.digest, 'digest is deterministic');
  assert.equal(a.digest, committed.digest, 'rebuild matches the committed fixture');
  assert.equal(a.resultHash, committed.resultHash, 'resultHash matches the committed fixture');
  ok('receipt build is deterministic (stable digest + resultHash)');
}

// 3. resultHash is machine-independent: build time, toolchain, install path + plane do not change it
{
  const cap = captureOf(committed);
  const otherMachine = buildGcliReceipt({
    ...cap,
    plane: 'some-other-linux-runner',
    host: { os: 'Debian', labviewEdition: 'LabVIEW 2026 CE' },
    toolchain: { rustc: '1.80.0', cargo: '1.80.0', profile: 'release' }, // different toolchain
    labview: { version: cap.labview.version, bitness: cap.labview.bitness, installPath: '/opt/ni/LabVIEW-2026-64' },
    buildSeconds: 41, roundTripSeconds: 9, // different perf
  });
  assert.equal(otherMachine.resultHash, committed.resultHash, 'same proof identity -> same resultHash across machines');
  assert.equal(otherMachine.verdict.proofOk, true, 'still a passing proof on the other machine');
  ok('resultHash is machine-independent (build-time / toolchain / install-path invariant)');
}

// 4. FAIL CLOSED: a tampered resultHash
{
  const t = { ...committed, resultHash: '0'.repeat(64) };
  const v = validateGcliReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /resultHash/.test(f)), 'a tampered resultHash must be rejected');
  ok('fail-closed: a tampered resultHash is rejected');
}

// 5. FAIL CLOSED: a forged verdict -- an honest FAILED round-trip (LabVIEW exited 1) reshaped to claim success
{
  const honestFail = buildGcliReceipt({ ...captureOf(committed), exitCode: 1 });
  assert.equal(honestFail.verdict.proofOk, false, 'a non-zero LabVIEW exit must fail the proof');
  const forged = structuredClone(honestFail);
  forged.verdict.proofOk = true;                // claim it passed...
  forged.resultHash = computeResultHash({       // ...and re-derive the hash for the forged shape
    tool: forged.tool, version: forged.version, sourceCommit: forged.source.commit, operation: forged.operation,
    launchTargetVi: forged.launchTargetVi, argsIn: forged.argsIn, echoedText: forged.echoedText,
    exitCode: forged.exitCode, labviewVersion: forged.labview.version, labviewBitness: forged.labview.bitness,
  });
  forged.digest = digestReceipt(forged);        // re-seal
  const v = validateGcliReceipt(forged);
  assert.ok(!v.ok, 'a forged proofOk verdict (resealed) must be rejected');
  ok('fail-closed: a forged verdict over a failed round-trip is rejected');
}

// 6. FAIL CLOSED: the round-trip echoed the wrong text (LabVIEW did not return the args sent)
{
  const mismatch = buildGcliReceipt({ ...captureOf(committed), echoedText: 'goodbye\tfrom\thost' });
  assert.equal(mismatch.roundTripEchoed, false, 'a wrong echo is not a round-trip');
  const v = validateGcliReceipt(mismatch);
  assert.ok(!v.ok && v.findings.some((f) => /echo/i.test(f)), 'an echo that does not match the args sent must be rejected');
  ok('fail-closed: an echo that does not match the args sent is rejected');
}

// 7. FAIL CLOSED: a tampered digest
{
  const t = { ...committed, digest: '0'.repeat(64) };
  const v = validateGcliReceipt(t);
  assert.ok(!v.ok && v.findings.some((f) => /digest/.test(f)), 'a tampered digest must be rejected');
  ok('fail-closed: a tampered digest is rejected');
}

console.log(`\n# g-cli-proxy-proof self-test: ${n}/${n} passed`);
