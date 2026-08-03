// verify-launch-capture.mjs — deterministic self-test for the VM-local LabVIEW-launch capture assembler
// (mprr dual-packet) + the frame-correlator document builder. No VM: synthetic frames + resource samples.
//
// Run: node experiments/mprr-capture-ring/verify-launch-capture.mjs

import { buildLaunchCapture, LAUNCH_CAPTURE_SCHEMA } from './launch-capture.mjs';
import { buildFrameCorrelatorHtml } from './frame-correlator.mjs';
import { correlateDualStream as canonicalDual } from '../mprr-ring/mprrDualPacket.mjs';

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log('  ok   ' + label); }
  else { failures += 1; console.log('  FAIL ' + label + (detail ? '  -- ' + detail : '')); }
}

// 6 frames at 12 fps (~83.3 ms apart), from epoch 100000. CPU/RAM/disk sampled at a coarser cadence.
const startMs = 100000;
const frames = [];
for (let i = 0; i < 6; i += 1) {
  frames.push({ imageFile: 'frame-' + String(i).padStart(5, '0') + '.png', imageBytes: 1000 + i * 10, ms: startMs + Math.round((i * 1000) / 12) });
}
const resourceSamples = [
  { ms: 100000, cpuPct: 5, ramMb: 600, diskPct: 1 },
  { ms: 100200, cpuPct: 60, ramMb: 700, diskPct: 40 },
  { ms: 100400, cpuPct: 15, ramMb: 760, diskPct: 3 },
];

console.log('buildLaunchCapture (mprr dual-packet)');
const cap = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN', screenW: 1280, screenH: 800 } });
check('schema', cap.schema === LAUNCH_CAPTURE_SCHEMA);
check('frame count', cap.frameCount === 6 && cap.frames.length === 6);
check('frame 0 t=0', cap.frames[0].tMs === 0);
check('timing ticks are 100ns (frame0=0)', cap.frames[0].timingTicks64 === '0');
check('resource arrays per metric', cap.resources.cpu.length === 6 && cap.resources.ram.length === 6 && cap.resources.disk.length === 6);
check('frame 0 nearest sample (cpu 5 @100000)', cap.frames[0].cpuPct === 5);
check('frame ~t250ms nearest sample (cpu 60 @100200)', cap.frames[3].cpuPct === 60, 'got ' + cap.frames[3].cpuPct);
check('dual-packet authoritative (all longs admitted)', cap.dualPacket.authoritative === true && cap.dualPacket.authoritativeFrames === 6);
// drift guard: the inlined dual-packet correlation must match the canonical mprr-ring/mprrDualPacket.mjs.
const canon = canonicalDual(cap.frames.map((f) => ({ frameIndex: f.index, shortBytes: 24, longBytes: f.imageBytes })), {});
check('inlined dual-packet matches canonical mprrDualPacket (no drift)', JSON.stringify(canon) === JSON.stringify(cap.dualPacket));
check('image (long-packet) ref carried', cap.frames[2].image === 'frame-00002.png' && cap.frames[2].imageBytes === 1020);
check('screen dims', cap.screen && cap.screen.width === 1280 && cap.screen.height === 800);
check('deterministic', JSON.stringify(buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN', screenW: 1280, screenH: 800 } })) === JSON.stringify(cap));
// dual-packet degradation: a tiny capacity defers longs (short continuity protected).
const tight = buildLaunchCapture({ frames, resourceSamples, startMs, fps: 12, capacityBytes: 24 * 6 + 1500 });
check('tight capacity defers some long payloads (short-protected)', tight.dualPacket.authoritative === false && tight.dualPacket.authoritativeFrames < 6);
let threw = false;
try { buildLaunchCapture({ frames: [] }); } catch { threw = true; }
check('empty frames throws', threw);

// v2: a sampler that emits a counters{} object -> each frame carries its nearest sample's counters, and the
// record exposes the counterKeys union; a legacy flat capture stays byte-compatible (no counters / counterKeys).
const v2 = buildLaunchCapture({
  frames,
  resourceSamples: [
    { ms: 100000, cpuPct: 5, ramMb: 600, diskPct: 1, counters: { cpuTotalPct: 5, memAvailableMb: 4000, diskWriteBytesPerSec: 0 } },
    { ms: 100300, cpuPct: 55, ramMb: 720, diskPct: 30, counters: { cpuTotalPct: 55, memAvailableMb: 3800, diskWriteBytesPerSec: 5e6 } },
  ],
  startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'LINUX' },
});
check('v2: frames carry the nearest sample counters{}', v2.frames[0].counters && v2.frames[0].counters.cpuTotalPct === 5, JSON.stringify(v2.frames[0].counters));
check('v2: record exposes the counterKeys union', Array.isArray(v2.counterKeys) && v2.counterKeys.includes('cpuTotalPct') && v2.counterKeys.includes('diskWriteBytesPerSec'));
check('back-compat: a flat capture has no counters / counterKeys', cap.counterKeys === undefined && cap.frames[0].counters === undefined);
const v2html = buildFrameCorrelatorHtml({ title: 'v2', fps: 12, selectedIndex: 0, frames: v2.frames.map((f) => ({ index: f.index, tMs: f.tMs, counters: f.counters, imageSrc: 'x' })) }, 'nv2', '');
check('v2: counters flow through buildLaunchCapture -> the correlator webview island', v2html.includes('cpuTotalPct'));

// per-physical-disk throughput: a sampler that emits disks[] -> each frame carries its nearest sample's per-disk
// read/write MB/s, the record exposes the diskNames union, and a legacy flat capture stays byte-compatible.
const dt = buildLaunchCapture({
  frames,
  resourceSamples: [
    { ms: 100000, cpuPct: 5, ramMb: 600, diskPct: 1, disks: [{ name: '0 C:', writeMBs: 0, readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 0 }] },
    { ms: 100300, cpuPct: 55, ramMb: 720, diskPct: 2, disks: [{ name: '0 C:', writeMBs: 11.4, readMBs: 0 }, { name: '1 D:', writeMBs: 0, readMBs: 3.2 }] },
  ],
  startMs, fps: 12, meta: { workload: 'labview-launch', plane: 'WIN' },
});
check('disk: frames carry the nearest sample per-disk throughput', Array.isArray(dt.frames[3].disks) && dt.frames[3].disks[0].name === '0 C:' && dt.frames[3].disks[0].writeMBs === 11.4, JSON.stringify(dt.frames[3].disks));
check('disk: record exposes the diskNames union', Array.isArray(dt.diskNames) && dt.diskNames.join(',') === '0 C:,1 D:');
check('back-compat: a capture without disks[] has no diskNames', cap.diskNames === undefined && cap.frames[0].disks === undefined);
const dthtml = buildFrameCorrelatorHtml({ title: 'disk', fps: 12, selectedIndex: 3, diskNames: dt.diskNames, frames: dt.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, disks: f.disks, imageSrc: 'x' })) }, 'nvd', '');
check('disk: per-disk throughput + values flow into the correlator document', dthtml.includes(' write MB/s') && dthtml.includes(' read MB/s') && dthtml.includes('"writeMBs":11.4'));

console.log('buildFrameCorrelatorHtml');
const model = {
  title: 'Launch </script> correlator',
  fps: 12,
  selectedIndex: 2,
  frames: cap.frames.map((f) => ({ index: f.index, tMs: f.tMs, cpuPct: f.cpuPct, ramMb: f.ramMb, diskPct: f.diskPct, imageSrc: 'https://file+.vscode-resource/' + f.image })),
};
const nonce = 'nonce-abc123';
const html = buildFrameCorrelatorHtml(model, nonce, 'https://file+.vscode-resource');
check('DOCTYPE', /^<!DOCTYPE html>/.test(html));
check('CSP carries the nonce', html.includes("script-src 'nonce-" + nonce + "'"));
check('CSP img-src includes the webview cspSource (for VM-local frames)', html.includes('img-src https://file+.vscode-resource data:;'));
check('title < escaped', html.includes('Launch &lt;/script&gt; correlator'));
check('JSON island present + closed', /<script id="fc-model"[^>]*>[\s\S]*?<\/script>/.test(html));
const isl = html.match(/<script id="fc-model"[^>]*>([\s\S]*?)<\/script>/)[1];
check('island has no raw </script', !isl.toLowerCase().includes('</script'));
check('runtime references the draggable red line + pointer drag', html.includes('pointerdown') && html.includes('#ff3b30'));
check('runtime plots cpu/ram/disk curves', html.includes("'cpuPct'") && html.includes("'ramMb'") && html.includes("'diskPct'"));
check('runtime builds per-disk write/read throughput metrics', html.includes("'writeMBs'") && html.includes("'readMBs'") && html.includes(' write MB/s'));
check('lower frame img element present', html.includes('id="fc-img"'));
check('deterministic', buildFrameCorrelatorHtml(model, nonce, 'https://file+.vscode-resource') === html);

console.log('');
if (failures > 0) { console.error('verify-launch-capture: ' + failures + ' check(s) FAILED'); process.exit(1); }
console.log('verify-launch-capture: all checks passed');
