// verify-resource-correlated-record.mjs — deterministic self-test for the LIVE resource-correlated launch
// record (LBA-REQ-011 live). No VM: synthetic launch record + synthetic CPU/RAM/disk samples where the machine
// is BUSY while launching (pre-trigger) and IDLE once the IDE is READY (post-trigger), so the pre/post windows
// + deltas read the launch's resource cost. Also covers the guest->host epoch conversion, fail-closed inputs,
// determinism, and the REAL committed live fixture when present (the gate re-derives it).
//
// Run: node experiments/mprr-capture-ring/verify-resource-correlated-record.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildResourceCorrelatedLaunch,
  guestSamplesToHostEpoch,
  RESOURCE_CORRELATED_LAUNCH_SCHEMA,
} from './resource-correlated-record.mjs';
import { buildResourceUsageCorrelation } from '../resource-usage-correlation/resourceUsageCorrelation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('  ok   ' + label);
  } else {
    failures += 1;
    console.log('  FAIL ' + label + (detail ? '  -- ' + detail : ''));
  }
}
const approx = (a, b, eps = 0.01) => typeof a === 'number' && Math.abs(a - b) <= eps;

// A synthetic launch: capture frame 0 at host epoch 1000ms, UI-READY settle (trigger) at 3000ms.
const record = {
  schema: 'labview-benchmark-actor/boot-benchmark-v1',
  workload: 'labview-ide-launch',
  plane: 'LINUX',
  hypervisor: 'vbox-vnc',
  spans: [{ id: 'launchMs', from: 'WORKLOAD-START', to: 'UI-READY', clock: 'host', scope: 'cross-plane', ms: 2000 }],
  sourceDetail: { settleMs: 3000, framesCaptured: 100 },
};
// BUSY while launching (< 3000), IDLE once settled (>= 3000).
const hostSamples = [
  { epochMs: 1500, cpuPct: 80, ramMb: 2000, diskPct: 40 },
  { epochMs: 2000, cpuPct: 85, ramMb: 2200, diskPct: 50 },
  { epochMs: 2500, cpuPct: 78, ramMb: 2300, diskPct: 30 },
  { epochMs: 3500, cpuPct: 8, ramMb: 2350, diskPct: 2 },
  { epochMs: 4000, cpuPct: 5, ramMb: 2350, diskPct: 1 },
  { epochMs: 4500, cpuPct: 6, ramMb: 2360, diskPct: 1 },
];

console.log('resource-correlated launch record');
const rec = buildResourceCorrelatedLaunch({ record, hostSamples, epochMsAtFrameZero: 1000, frameRateHz: 12 });
check('schema', rec.schema === RESOURCE_CORRELATED_LAUNCH_SCHEMA);
check('carries the launchMs', rec.launchMs === 2000);
check('trigger = UI-READY settle instant', rec.triggerEpochMs === 3000 && rec.trigger === 'UI-READY');
check('trigger frame index (2000ms / 83.3ms)', rec.triggerFrameIndex === 24, String(rec.triggerFrameIndex));
check('pre/post split at the trigger (3 busy / 3 idle)', rec.preSampleCount === 3 && rec.postSampleCount === 3);
check('cpu pre mean 81 (busy launch)', approx(rec.windows.cpu.pre.mean, 81));
check('cpu post mean ~6.33 (settled idle)', approx(rec.windows.cpu.post.mean, 6.3333));
check('cpu deltaMean ~ -74.67 (drops after settle)', approx(rec.headline.cpuDeltaMean, -74.67));
check('ram deltaMean ~ +186.67 (higher after load)', approx(rec.headline.ramDeltaMean, 186.67));
check('disk deltaMean ~ -38.67 (I/O drops after settle)', approx(rec.headline.diskDeltaMean, -38.67));
check('headline pre/post means present', approx(rec.headline.cpuPreMean, 81) && approx(rec.headline.cpuPostMean, 6.33));
check('deterministic', JSON.stringify(buildResourceCorrelatedLaunch({ record, hostSamples, epochMsAtFrameZero: 1000, frameRateHz: 12 })) === JSON.stringify(rec));

console.log('guest -> host epoch conversion');
const guest = [{ epochMs: 105000, cpuPct: 50 }, { epochMs: 105100, cpuPct: 60 }];
const hostOffset = guestSamplesToHostEpoch(guest, 5000); // guest is 5s ahead of host
check('host epoch = guest - offset', hostOffset[0].epochMs === 100000 && hostOffset[1].epochMs === 100100);
check('conversion preserves metrics', hostOffset[0].cpuPct === 50);
// end-to-end: converting then correlating == correlating host-epoch directly.
const viaOffset = buildResourceCorrelatedLaunch({ record, hostSamples: guestSamplesToHostEpoch(hostSamples.map((s) => ({ ...s, epochMs: s.epochMs + 7000 })), 7000), epochMsAtFrameZero: 1000, frameRateHz: 12 });
check('offset round-trip yields identical windows', JSON.stringify(viaOffset.windows) === JSON.stringify(rec.windows));

console.log('fail-closed');
let threw = 0;
try { buildResourceCorrelatedLaunch({ hostSamples, epochMsAtFrameZero: 1000 }); } catch { threw += 1; }
try { buildResourceCorrelatedLaunch({ record: { spans: [] }, hostSamples, epochMsAtFrameZero: 1000 }); } catch { threw += 1; }
try { buildResourceCorrelatedLaunch({ record, hostSamples: [], epochMsAtFrameZero: 1000 }); } catch { threw += 1; }
try { guestSamplesToHostEpoch(hostSamples, NaN); } catch { threw += 1; }
check('throws on missing record, missing trigger, empty samples, bad offset', threw === 4, String(threw));

// REAL committed live fixture (present after the live capture): the committed windows must re-derive from the
// committed host-epoch samples (deterministic no-rot), exactly what the local gate asserts.
const fixturePath = join(HERE, 'fixtures', 'labview-launch-resource-correlation.json');
if (existsSync(fixturePath)) {
  console.log('real committed live fixture');
  const fx = JSON.parse(readFileSync(fixturePath, 'utf8'));
  check('fixture schema', fx.schema === RESOURCE_CORRELATED_LAUNCH_SCHEMA);
  check('fixture is a real launch (LINUX/vbox, launchMs > 0)', fx.plane === 'LINUX' && fx.hypervisor === 'vbox-vnc' && fx.launchMs > 0);
  check('fixture has both pre + post samples', fx.preSampleCount > 0 && fx.postSampleCount > 0);
  const re = buildResourceUsageCorrelation({ frameRateHz: fx.frameRateHz, epochMsAtFrameZero: fx.epochMsAtFrameZero, triggerEpochMs: fx.triggerEpochMs, samples: fx.samples });
  check('committed windows re-derive from the committed samples (no rot)', JSON.stringify(re.windows) === JSON.stringify(fx.windows));
  console.log(`  ..   real: cpuΔ ${fx.headline.cpuDeltaMean} ram Δ ${fx.headline.ramDeltaMean} disk Δ ${fx.headline.diskDeltaMean} (pre ${fx.preSampleCount} / post ${fx.postSampleCount})`);
} else {
  console.log('  ..   live fixture not present yet (set after the real capture)');
}

console.log('');
if (failures > 0) {
  console.error('verify-resource-correlated-record: ' + failures + ' check(s) FAILED');
  process.exit(1);
}
console.log('verify-resource-correlated-record: all checks passed');
