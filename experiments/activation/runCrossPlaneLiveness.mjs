#!/usr/bin/env node
// LIVE cross-plane LabVIEW liveness runner (LBA-REQ-042, ADR-0030). Discovers every LabVIEW-capable plane --
// this host (if LabVIEWCLI is present) + running VirtualBox VMs that have LabVIEWCLI over their ssh forward --
// runs the known-answer activation probe on EACH plane CONCURRENTLY, and writes a cross-plane liveness
// receipt. NOT run in CI (needs LabVIEW + the VMs); the committed receipt replays deterministically via
// verify-cross-plane-liveness.selftest.mjs. Usage:  node experiments/activation/runCrossPlaneLiveness.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { buildLivenessReceipt, validateLiveness } from './crossPlaneLiveness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LVCLI = '/usr/local/bin/LabVIEWCLI';
const VIP = '/usr/local/natinst/share/nilvcli/Examples/AddTwoNumbers/AddTwoNumbers.vi';
const LVP = '/usr/local/natinst/LabVIEW-2026-64/labview';
const A = 7, B = 5, EXPECTED = A + B;
const SSH = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8'];
const probeCmd = () => `timeout 200 xvfb-run -a ${LVCLI} -LabVIEWPath ${LVP} -OperationName RunVI -VIPath ${VIP} ${A} ${B}`;

// Discover LabVIEW planes: the host (if LabVIEWCLI) + running VBox VMs that answer `ls LabVIEWCLI` over ssh.
function discoverPlanes() {
  const planes = [];
  if (existsSync(LVCLI)) planes.push({ instance: 'host', dispatch: 'local', hostname: hostname(), os: 'linux' });
  try {
    const vms = execFileSync('VBoxManage', ['list', 'runningvms'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean);
    for (const vm of vms) {
      const info = execFileSync('VBoxManage', ['showvminfo', vm, '--machinereadable'], { encoding: 'utf8' });
      const port = (info.match(/Forwarding\(\d+\)="ssh,tcp,[^,]*,(\d+),,22"/) || [])[1];
      if (!port) continue;
      const chk = spawnSync('ssh', ['-p', port, ...SSH, 'actor@127.0.0.1', `ls ${LVCLI} 2>/dev/null`], { encoding: 'utf8', timeout: 20000 });
      if ((chk.stdout || '').includes('LabVIEWCLI')) planes.push({ instance: `vm:${vm}`, dispatch: 'ssh', port, os: 'linux' });
    }
  } catch (e) { console.error(`  (VM discovery skipped: ${e.message})`); }
  return planes;
}

function runProbe(plane) {
  if (plane.dispatch === 'local') {
    const r = spawnSync('bash', ['-c', probeCmd()], { cwd: resolve(here, '..', '..'), encoding: 'utf8', timeout: 230000 });
    return { ...plane, inputs: [A, B], expectedOutput: EXPECTED, exitCode: r.status ?? 1, output: (r.stdout || '') + (r.stderr || '') };
  }
  const r = spawnSync('ssh', ['-p', plane.port, ...SSH, 'actor@127.0.0.1', `echo "HOST:$(hostname)"; ${probeCmd()}`], { encoding: 'utf8', timeout: 260000 });
  const out = (r.stdout || '') + (r.stderr || '');
  return { ...plane, hostname: (out.match(/HOST:(\S+)/) || [])[1] || plane.instance, inputs: [A, B], expectedOutput: EXPECTED, exitCode: r.status ?? 1, output: out };
}

const planes = discoverPlanes();
console.log(`LabVIEW planes: ${planes.map((p) => p.instance).join(', ')}`);
if (planes.length < 2) { console.error('need >= 2 LabVIEW planes; is a LabVIEW VM running?'); process.exit(1); }

const results = await Promise.all(planes.map((p) => Promise.resolve().then(() => runProbe(p))));
const receipt = buildLivenessReceipt({ workload: `labview activation probe (AddTwoNumbers known-answer ${A}+${B}=${EXPECTED})`, planes: results });
const v = validateLiveness(receipt);
mkdirSync(join(here, 'fixtures'), { recursive: true });
writeFileSync(join(here, 'fixtures', 'cross-plane-liveness-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

for (const p of receipt.planes) console.log(`  ${p.instance} [${p.hostname}] LabVIEW ${p.labviewVersion}: ${p.inputs.join(' + ')} = ${p.parsedOutput} activated=${p.activated}`);
console.log(`cross-plane: ${receipt.planeCount} LabVIEW planes, allActivated=${receipt.allActivated}; valid=${v.ok}${v.ok ? '' : ' findings=' + v.findings.join('; ')}`);
