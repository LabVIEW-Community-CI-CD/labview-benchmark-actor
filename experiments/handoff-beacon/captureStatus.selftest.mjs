#!/usr/bin/env node
// captureStatus.selftest.mjs -- deterministic self-test for the Handoff Beacon capture-status payload
// (LBA-REQ-055, ADR-0035). No VM: synthetic record + resource samples.
// Run: node experiments/handoff-beacon/captureStatus.selftest.mjs

import assert from 'node:assert/strict';
import {
  CAPTURE_STATUS_SCHEMA,
  buildCapturingStatus,
  buildFailedStatus,
  buildCaptureStatus,
  validateCaptureStatus,
} from './captureStatus.mjs';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ok  ${name}`); };

// synthetic assembled record: 6 frames @ 12 fps from startMs, two physical disks.
const startMs = 1_000_000;
const frames = Array.from({ length: 6 }, (_, i) => ({ index: i, tMs: Math.round((i * 1000) / 12), ms: startMs + Math.round((i * 1000) / 12) }));
const record = { schema: 'labview-benchmark-actor/launch-capture@1', startMs, frameCount: 6, durationMs: frames[5].tMs, diskNames: ['0 C:', '1 D:'], frames };
// samples: disk "0 C:" peaks at 11.4 MB/s write near frame 3 (tMs 250); "1 D:" only reads.
const samples = [
  { ms: startMs + 0,   disks: [{ name: '0 C:', writeMBs: 0,    readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 0.5 }] },
  { ms: startMs + 100, disks: [{ name: '0 C:', writeMBs: 2,    readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 1 }] },
  { ms: startMs + 250, disks: [{ name: '0 C:', writeMBs: 11.4, readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 2 }] },
  { ms: startMs + 350, disks: [{ name: '0 C:', writeMBs: 3,    readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 3 }] },
  { ms: startMs + 450, disks: [{ name: '0 C:', writeMBs: 0,    readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 0 }] },
];

ok('buildCapturingStatus is a capturing beacon', () => {
  const s = buildCapturingStatus({ runDir: 'C:\\run-1', startedAt: '2026-08-03T00:00:00Z' });
  assert.equal(s.schema, CAPTURE_STATUS_SCHEMA);
  assert.equal(s.state, 'capturing');
  assert.equal(s.runDir, 'C:\\run-1');
});

ok('buildCaptureStatus computes wroteToDisk, peak, per-disk', () => {
  const s = buildCaptureStatus(record, samples, { runDir: 'C:\\run-1' });
  assert.equal(s.state, 'stopped');
  assert.equal(s.frameCount, 6);
  assert.equal(s.durationMs, frames[5].tMs);
  assert.equal(s.samples, 5);
  assert.equal(s.writeSamples, 3, `writeSamples=${s.writeSamples}`);       // 2, 11.4, 3 all > 1 MB/s
  assert.equal(s.wroteToDisk, true);                                       // 3 >= 3
  assert.equal(s.peak.writeMBs, 11.4);
  assert.equal(s.peak.disk, '0 C:');
  assert.equal(s.peak.frameIndex, 3, `peakFrameIndex=${s.peak.frameIndex}`); // tMs 250 -> frame 3
  assert.deepEqual(s.perDisk, [
    { name: '0 C:', peakWriteMBs: 11.4, peakReadMBs: 0 },
    { name: '1 D:', peakWriteMBs: 0, peakReadMBs: 3 },
  ]);
  assert.deepEqual(s.diskNames, ['0 C:', '1 D:']);
  assert.equal(s.captureJsonReady, true);
});

ok('wroteToDisk fails closed below the sample threshold', () => {
  const s = buildCaptureStatus(record, samples, { writeMinSamples: 4 });
  assert.equal(s.wroteToDisk, false); // only 3 samples > 1 MB/s, need 4
  const idle = buildCaptureStatus(record, [
    { ms: startMs, disks: [{ name: '0 C:', writeMBs: 0.2, readMBs: 0 }] },
    { ms: startMs + 100, disks: [{ name: '0 C:', writeMBs: 0.1, readMBs: 0 }] },
  ]);
  assert.equal(idle.wroteToDisk, false); // nothing above 1 MB/s
  assert.equal(idle.peak.frameIndex, 0); // peak (0.2) maps to the nearest frame
});

ok('buildCaptureStatus is deterministic', () => {
  assert.equal(JSON.stringify(buildCaptureStatus(record, samples)), JSON.stringify(buildCaptureStatus(record, samples)));
});

ok('buildFailedStatus is a failed beacon with an error', () => {
  const s = buildFailedStatus({ runDir: 'C:\\run-1', error: 'ffmpeg produced no frames' });
  assert.equal(s.state, 'failed');
  assert.match(s.error, /no frames/);
});

ok('validateCaptureStatus admits a good beacon + fails closed on bad ones', () => {
  assert.equal(validateCaptureStatus(buildCaptureStatus(record, samples)).ok, true);
  assert.equal(validateCaptureStatus(buildCapturingStatus({})).ok, true);
  assert.equal(validateCaptureStatus(buildFailedStatus({ error: 'x' })).ok, true);
  assert.equal(validateCaptureStatus({ schema: 'nope', state: 'stopped' }).ok, false);
  assert.equal(validateCaptureStatus({ schema: CAPTURE_STATUS_SCHEMA, state: 'bogus' }).ok, false);
  assert.equal(validateCaptureStatus({ schema: CAPTURE_STATUS_SCHEMA, state: 'stopped' }).ok, false); // missing payload
  assert.equal(validateCaptureStatus({ schema: CAPTURE_STATUS_SCHEMA, state: 'failed' }).ok, false); // missing error
});

console.log(`capture-status self-test: ${pass}/${pass} PASS`);
