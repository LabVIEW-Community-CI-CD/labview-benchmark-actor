// verify-boot-benchmark.mjs — CI-runnable proof of the boot-benchmark recorder seam (no VM / no hardware).
//
// Synthesizes a captured mesh-actor boot session (frames + serial pins + journald guest timing), seals it via
// the shared seal-boot-benchmark core, and asserts: the dual-clock anchor + milestone pins, the clock-tagged
// spans (guest cross-plane vs host within-plane), the fail-closed correlation gates, the serial + journald
// parsers, the VBox capture backend contract (injected exec), and a cross-iteration timing + visual delta.
//
//   node experiments/mprr-boot-benchmark/verify-boot-benchmark.mjs

import assert from 'node:assert/strict';
import { sealBootBenchmark } from './seal-boot-benchmark.mjs';
import { recordBoot } from './boot-recorder.mjs';
import { formatSerialMarker, parseSerialMarkerLine, parseSerialLog } from './serial-marker.mjs';
import { parseShortMonotonicLine, parseJournalMonotonic } from './journal-monotonic.mjs';
import { createVboxBackend, vboxSerialConfigArgs } from './capture-backend-vbox.mjs';
import { hammingHex } from '../manual-procedure-record/fingerprint.mjs';
import { encodePng } from '../manual-procedure-record/capture-adapter.mjs';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }

// --- synthetic frame helpers (9x8 grayscale; column profile => deterministic dhash-64) ------------------
const FLAT = new Array(9).fill(128);              // flat => dhash '0000000000000000'
const ASC = [0, 32, 64, 96, 128, 160, 192, 224, 255];   // ascending => all bits 0 => '0000...'
const DESC = [...ASC].reverse();                  // descending => all bits 1 => 'ffffffffffffffff'
function frameFromProfile(profile, hostMonotonicMs) {
  const width = 9;
  const height = 8;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = profile[x] & 0xff;
      const di = (y * width + x) * 4;
      rgba[di] = v; rgba[di + 1] = v; rgba[di + 2] = v; rgba[di + 3] = 255;
    }
  }
  return { hostMonotonicMs, rgba, width, height };
}

// A base happy-path captured boot session. 41 frames at 500ms (host 1500..21500), 4 milestone pins on the
// host grid, serial==journal (skew 0). Overrides let negative/variant tests mutate one thing.
function makeSession(overrides = {}) {
  const HOST_T0 = 1000;
  const frames = [];
  for (let i = 0; i < 41; i++) frames.push(frameFromProfile(FLAT, 1500 + i * 500));
  // apply per-index profile overrides (for the visual-delta test)
  for (const [idx, profile] of Object.entries(overrides.frameProfiles ?? {})) {
    frames[Number(idx)] = frameFromProfile(profile, 1500 + Number(idx) * 500);
  }
  const serialMarkers = overrides.serialMarkers ?? [
    { caseId: 'BOOT-START', serialMonotonicMs: 300, hostArrivalMonotonicMs: 4000 },
    { caseId: 'LBABUS-BUILD-START', serialMonotonicMs: 8000, hostArrivalMonotonicMs: 12000 },
    { caseId: 'LBABUS-BUILT', serialMonotonicMs: 16000, hostArrivalMonotonicMs: 20000 },
    { caseId: 'MESH-OK', serialMonotonicMs: 17000, hostArrivalMonotonicMs: 21000 },
  ];
  const guestTiming = overrides.guestTiming ?? {
    'BOOT-START': 300, 'LBABUS-BUILD-START': 8000, 'LBABUS-BUILT': 16000, 'MESH-OK': 17000,
  };
  return {
    iteration: overrides.iteration ?? 'test-v1',
    sessionId: 'sess-1',
    vm: 'lba-ubuntu2404-labview2026-scratch',
    hypervisor: 'virtualbox',
    plane: 'LINUX',
    capture: { backend: 'vbox-screenshotpng', transport: 'VBoxManage controlvm screenshotpng', cadenceHz: 2 },
    procedure: { id: 'mesh-actor-boot', milestones: ['BOOT-START', 'LBABUS-BUILD-START', 'LBABUS-BUILT', 'MESH-OK'] },
    hostT0MonotonicMs: HOST_T0,
    frames,
    serialMarkers,
    guestTiming,
    sealedAt: '2026-07-30T13:40:00.000Z',
    ...(overrides.top ?? {}),
  };
}

console.log('boot-benchmark seal — happy path');
{
  const rec = sealBootBenchmark(makeSession());
  assert.equal(rec.schema, 'labview-benchmark-actor/boot-benchmark-v1'); ok('schema id');
  assert.equal(rec.plane, 'LINUX'); assert.equal(rec.hypervisor, 'virtualbox'); ok('plane + hypervisor');
  assert.equal(rec.capture.backend, 'vbox-screenshotpng'); ok('capture.backend recorded');

  // dual-clock anchor + pins
  assert.equal(rec.anchor.source, 'host-capture-timeline');
  assert.equal(rec.anchor.hostClock, 'monotonic-ms');
  assert.equal(rec.anchor.guestClock, 'journald-short-monotonic');
  assert.equal(rec.anchor.hostT0MonotonicMs, 1000); ok('dual-clock anchor');
  assert.equal(rec.anchor.correlation.allMilestonesPinned, true);
  assert.equal(rec.anchor.correlation.pins.length, 4); ok('all 4 milestones pinned');
  const pin = (c) => rec.anchor.correlation.pins.find((p) => p.caseId === c);
  assert.equal(pin('BOOT-START').frameIndex, 5);
  assert.equal(pin('LBABUS-BUILD-START').frameIndex, 21);
  assert.equal(pin('LBABUS-BUILT').frameIndex, 37);
  assert.equal(pin('MESH-OK').frameIndex, 39); ok('pins -> nearest-in-host-time frame');
  assert.equal(pin('MESH-OK').guestMonotonicMs, 17000);
  assert.equal(pin('MESH-OK').skewMs, 0); ok('authoritative guest ms + skew cross-check');

  // milestone frames stamped; non-milestone frames are clean timeline
  assert.equal(rec.frames[5].caseId, 'BOOT-START');
  assert.equal(rec.frames[5].settled, true);
  assert.equal(rec.frames[5].guestMonotonicMs, 300); ok('milestone frame stamped (caseId+guest+settled)');
  assert.equal(rec.frames[0].caseId, undefined);
  assert.equal(rec.frames[0].settled, undefined); ok('non-milestone frames are pure timeline (no caseId)');

  // spans tagged by clock + scope
  const span = (id) => rec.spans.find((s) => s.id === id);
  assert.deepEqual(
    { ms: span('buildMs').ms, clock: span('buildMs').clock, scope: span('buildMs').scope },
    { ms: 8000, clock: 'guest', scope: 'cross-plane' },
  ); ok('buildMs = 8000ms (guest / cross-plane)');
  assert.deepEqual(
    { ms: span('meshFormMs').ms, clock: span('meshFormMs').clock, scope: span('meshFormMs').scope },
    { ms: 1000, clock: 'guest', scope: 'cross-plane' },
  ); ok('meshFormMs = 1000ms (guest / cross-plane)');
  assert.deepEqual(
    { ms: span('bootToMeshMs').ms, clock: span('bootToMeshMs').clock, scope: span('bootToMeshMs').scope },
    { ms: 20000, clock: 'host', scope: 'within-plane' },
  ); ok('bootToMeshMs = 20000ms (host / within-plane)');

  // visual policy = witness (not gated) with permissive defaults
  assert.equal(rec.visual.gated, false);
  assert.equal(rec.visual.perMilestone.length, 4);
  assert.equal(rec.visual.perMilestone[0].hammingTolerance, 64);
  assert.equal(rec.visual.perMilestone[0].roiMask, null); ok('visual witness: gated=false, permissive defaults');

  // seal: raw discarded, tamper-evident hash, no pixels retained
  assert.equal(rec.seal.rawDiscarded, true);
  assert.equal(rec.seal.frameCount, 41);
  assert.match(rec.seal.recordHash, /^[0-9a-f]{64}$/); ok('sealed: rawDiscarded + recordHash');
  assert.equal(rec.frames.every((f) => !('rgba' in f) && !('png' in f)), true); ok('no raw pixels in sealed frames');
}

console.log('boot-benchmark seal — PNG-decoded frame path');
{
  const s = makeSession();
  const f0 = s.frames[0];
  s.frames[0] = { hostMonotonicMs: f0.hostMonotonicMs, png: encodePng(f0.rgba, f0.width, f0.height) };
  const rec = sealBootBenchmark(s);
  assert.match(rec.frames[0].perceptualFingerprint, /^[0-9a-f]{16}$/); ok('frame supplied as PNG decodes + fingerprints');
}

console.log('boot-benchmark seal — fail-closed determinism');
{
  // missing serial pin for a milestone
  const noPin = makeSession({ serialMarkers: [
    { caseId: 'BOOT-START', serialMonotonicMs: 300, hostArrivalMonotonicMs: 4000 },
    { caseId: 'LBABUS-BUILD-START', serialMonotonicMs: 8000, hostArrivalMonotonicMs: 12000 },
    { caseId: 'LBABUS-BUILT', serialMonotonicMs: 16000, hostArrivalMonotonicMs: 20000 },
  ] });
  assert.throws(() => sealBootBenchmark(noPin), /MESH-OK has no serial pin/); ok('missing serial pin -> NOT sealed');

  // missing authoritative guest time
  const noGuest = makeSession({ guestTiming: { 'BOOT-START': 300, 'LBABUS-BUILD-START': 8000, 'LBABUS-BUILT': 16000 } });
  assert.throws(() => sealBootBenchmark(noGuest), /MESH-OK has no authoritative guest time/); ok('missing journald time -> NOT sealed');

  // skew beyond tolerance (serial says 16000, journald says 16800 -> 800ms > 500ms)
  const skew = makeSession({ guestTiming: { 'BOOT-START': 300, 'LBABUS-BUILD-START': 8000, 'LBABUS-BUILT': 16800, 'MESH-OK': 17000 } });
  assert.throws(() => sealBootBenchmark(skew), /skew 800ms > tolerance 500ms/); ok('serial/journald skew > tolerance -> NOT sealed');

  // non-monotonic span (BUILT before BUILD-START)
  const nonMono = makeSession({ guestTiming: { 'BOOT-START': 300, 'LBABUS-BUILD-START': 8000, 'LBABUS-BUILT': 7000, 'MESH-OK': 17000 } });
  // keep skew ok by matching serial to the (bad) journald time
  nonMono.serialMarkers = nonMono.serialMarkers.map((m) => m.caseId === 'LBABUS-BUILT' ? { ...m, serialMonotonicMs: 7000 } : m);
  assert.throws(() => sealBootBenchmark(nonMono), /non-monotonic/); ok('non-monotonic span -> NOT sealed');
}

console.log('serial-marker parser');
{
  const line = formatSerialMarker('LBABUS-BUILT', 21.234567);
  assert.equal(line, 'LBABENCH LBABUS-BUILT mono=21.234567'); ok('formatSerialMarker wire shape');
  assert.deepEqual(parseSerialMarkerLine(line), { caseId: 'LBABUS-BUILT', serialMonotonicMs: 21235 }); ok('parse round-trip (ms)');
  assert.equal(parseSerialMarkerLine('not a marker'), null); ok('non-marker -> null');
  // tolerate a leading serial-console timestamp/junk prefix
  assert.deepEqual(parseSerialMarkerLine('[boot] LBABENCH MESH-OK mono=17.0'), { caseId: 'MESH-OK', serialMonotonicMs: 17000 }); ok('prefix-tolerant');
  const log = ['garbage', 'LBABENCH BOOT-START mono=0.5', 'noise', 'LBABENCH BOOT-START mono=9.9', 'LBABENCH MESH-OK mono=17.0'].join('\n');
  const parsed = parseSerialLog(log);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].caseId, 'BOOT-START');
  assert.equal(parsed[0].serialMonotonicMs, 500); // first-per-case wins
  assert.equal(parsed[1].caseId, 'MESH-OK'); ok('parseSerialLog: first-per-case, ignores noise');
}

console.log('journal-monotonic parser');
{
  const l = parseShortMonotonicLine('[   21.234567] host lba-lbabus-build[789]: lbabus built -> /usr/local/bin/lbabus');
  assert.equal(l.monotonicMs, 21235);
  assert.match(l.message, /lbabus built/); ok('parseShortMonotonicLine timestamp + message');
  const dump = [
    '[    0.512000] host lbabench[1]: LBABENCH BOOT-START mono=0.512',
    '[    5.100000] host systemd[1]: Starting lba-lbabus-build.service...',
    '[    5.250000] host lba-lbabus-build[789]: building lbabus from /opt/lba/src (offline self-contained single-file)...',
    '[   13.400000] host lba-lbabus-build[789]: lbabus built -> /usr/local/bin/lbabus',
    '[   21.900000] host lba-mesh[812]: MESH OK (TCP+UDP)',
  ].join('\n');
  const t = parseJournalMonotonic(dump);
  assert.deepEqual(t, { 'BOOT-START': 512, 'LBABUS-BUILD-START': 5250, 'LBABUS-BUILT': 13400, 'MESH-OK': 21900 }); ok('parseJournalMonotonic maps all 4 milestones');
}

console.log('VBox capture backend (injected exec)');
{
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === 'showvminfo') return { status: 0, stdout: 'name="X"\nVMState="running"\nUUID="..."\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createVboxBackend({ vm: 'X', exec });
  assert.equal(be.backend, 'vbox-screenshotpng'); ok('backend id');
  const p = be.probe();
  assert.deepEqual(p, { ok: true, state: 'running' });
  assert.deepEqual(calls.at(-1), ['VBoxManage', 'showvminfo', 'X', '--machinereadable']); ok('probe -> showvminfo argv + VMState');
  const cap = be.capture('/tmp/f.png');
  assert.deepEqual(cap, { ok: true, path: '/tmp/f.png' });
  assert.deepEqual(calls.at(-1), ['VBoxManage', 'controlvm', 'X', 'screenshotpng', '/tmp/f.png']); ok('capture -> controlvm screenshotpng argv');
  const st = be.start();
  assert.equal(st.ok, true);
  assert.deepEqual(calls.at(-1), ['VBoxManage', 'startvm', 'X', '--type', 'headless']); ok('start -> startvm headless argv');
  // failure surfaces, never throws
  const beFail = createVboxBackend({ vm: 'Y', exec: () => ({ status: 1, stdout: '', stderr: 'VBOX_E_FILE_ERROR' }) });
  assert.equal(beFail.capture('/tmp/z.png').ok, false); ok('capture failure -> {ok:false}, no throw');
  // serial config argv
  assert.deepEqual(vboxSerialConfigArgs({ vm: 'X', hostFile: '/tmp/s' }), [
    ['modifyvm', 'X', '--uart1', '0x3F8', '4'],
    ['modifyvm', 'X', '--uartmode1', 'file', '/tmp/s'],
  ]); ok('vboxSerialConfigArgs argv (COM1 -> host file)');
}

console.log('cross-iteration timing + visual delta');
{
  // v1: build 8000ms, MESH-OK ascending frame ('0000...'); v2: build 12000ms, MESH-OK descending ('ffff...')
  const v1 = sealBootBenchmark(makeSession({ iteration: 'v1', frameProfiles: { 39: ASC } }));
  const v2 = sealBootBenchmark(makeSession({
    iteration: 'v2',
    frameProfiles: { 39: DESC },
    guestTiming: { 'BOOT-START': 300, 'LBABUS-BUILD-START': 8000, 'LBABUS-BUILT': 20000, 'MESH-OK': 21000 },
    serialMarkers: [
      { caseId: 'BOOT-START', serialMonotonicMs: 300, hostArrivalMonotonicMs: 4000 },
      { caseId: 'LBABUS-BUILD-START', serialMonotonicMs: 8000, hostArrivalMonotonicMs: 12000 },
      { caseId: 'LBABUS-BUILT', serialMonotonicMs: 20000, hostArrivalMonotonicMs: 20000 },
      { caseId: 'MESH-OK', serialMonotonicMs: 21000, hostArrivalMonotonicMs: 21000 },
    ],
  }));
  const build1 = v1.spans.find((s) => s.id === 'buildMs').ms;
  const build2 = v2.spans.find((s) => s.id === 'buildMs').ms;
  assert.equal(build1, 8000);
  assert.equal(build2, 12000);
  assert.ok(build2 > build1); ok(`timing regression detectable: buildMs ${build1} -> ${build2}`);

  // visual witness: the MESH-OK settled frames differ maximally; identical compares to 0
  const mesh1 = v1.frames[39].perceptualFingerprint;
  const mesh2 = v2.frames[39].perceptualFingerprint;
  assert.equal(mesh1, '0000000000000000');
  assert.equal(mesh2, 'ffffffffffffffff');
  assert.equal(hammingHex(mesh1, mesh2), 64); ok('visual witness: MESH-OK Hamming 64 (max delta)');
  assert.equal(hammingHex(mesh1, mesh1), 0); ok('visual witness: identical -> Hamming 0');
}

console.log('boot-recorder driver — await capture(), one driver fits sync + async backends');
{
  const mkClock = () => { let t = 1000; return () => { t += 10; return t; }; };
  const grayFrame = { rgba: new Uint8Array(9 * 8 * 4).fill(128), width: 9, height: 8 };
  const readFrame = () => grayFrame;
  const journalReader = () => ({ 'BOOT-START': 100, 'LBABUS-BUILD-START': 1000, 'LBABUS-BUILT': 9000, 'MESH-OK': 9500 });
  const mkSerial = () => {
    let n = -1;
    const sched = {
      0: [{ caseId: 'BOOT-START', serialMonotonicMs: 100 }],
      2: [{ caseId: 'LBABUS-BUILD-START', serialMonotonicMs: 1000 }],
      4: [{ caseId: 'LBABUS-BUILT', serialMonotonicMs: 9000 }],
      5: [{ caseId: 'MESH-OK', serialMonotonicMs: 9500 }],
    };
    return { poll() { n += 1; return sched[n] ?? []; } };
  };
  const baseOpts = () => ({
    iteration: 'drv', sessionId: 'd', vm: 'vm', hypervisor: 'virtualbox', plane: 'LINUX',
    readFrame, journalReader, serialSource: mkSerial(), clock: mkClock(), sleep: () => Promise.resolve(),
    cadenceHz: 2, sealedAt: '2026-07-30T14:00:00.000Z',
  });
  const syncBackend = { backend: 'vbox-screenshotpng', transport: 'VBoxManage controlvm screenshotpng', capture(path) { return { ok: true, path }; } };
  const asyncBackend = { backend: 'vmware-vnc', transport: 'vnc://127.0.0.1:5901 framebuffer', async capture(path) { return { ok: true, path }; } };

  const recSync = await recordBoot({ ...baseOpts(), backend: syncBackend });
  assert.equal(recSync.schema, 'labview-benchmark-actor/boot-benchmark-v1');
  assert.equal(recSync.anchor.correlation.pins.length, 4);
  assert.equal(recSync.frames.length, 6); ok('driver seals a boot from a SYNC (VBox) backend, stops at MESH-OK');
  assert.equal(recSync.spans.find((s) => s.id === 'buildMs').ms, 8000); ok('driver span buildMs = 8000 (guest clock)');

  const recAsync = await recordBoot({ ...baseOpts(), backend: asyncBackend });
  assert.equal(recAsync.capture.backend, 'vmware-vnc'); ok('driver seals a boot from an ASYNC (VMware VNC Promise) backend');

  // one driver fits both: identical frames + spans => identical recordHash (capture.backend is not hashed),
  // so `await backend.capture()` makes the sync + async backends interchangeable behind one driver.
  assert.equal(recSync.seal.recordHash, recAsync.seal.recordHash); ok('await capture(): sync + async backends yield an IDENTICAL sealed record');

  // fail-closed: a boot that never reaches MESH-OK does not seal
  const noMesh = () => { let n = -1; const sched = { 0: [{ caseId: 'BOOT-START', serialMonotonicMs: 100 }] }; return { poll() { n += 1; return sched[n] ?? []; } }; };
  let rejected = false;
  try { await recordBoot({ ...baseOpts(), serialSource: noMesh(), backend: syncBackend, maxDurationMs: 100 }); } catch { rejected = true; }
  assert.equal(rejected, true); ok('driver: a boot that never reaches MESH-OK fails closed (not sealed)');
}

console.log(`\nboot-benchmark verify: ${passed}/${passed} checks passed`);
