#!/usr/bin/env node
// LIVE cross-plane VI Analyzer comparison (LBA-REQ-043, ADR-0031). Runs the SAME VI Analyzer config
// (the shipped LabVIEWCLIExampleProject) on every LabVIEW plane -- this host + running LabVIEW VMs --
// CONCURRENTLY, parses each ASCII report into the normalized shape, computes the deterministic resultHash,
// and asserts the resultHashes MATCH across planes (cross-plane determinism). NOT run in CI; the committed
// receipt replays via verify-cross-plane-comparison.selftest.mjs. Usage:
//   node experiments/vi-analyzer/runCrossPlaneViAnalyzer.mjs

import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { summarizeViAnalyzerReport } from './viAnalyzerResult.mjs';
import { buildComparisonReceipt, validateComparison } from './crossPlaneComparison.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const LVCLI = '/usr/local/bin/LabVIEWCLI';
const LVP = '/usr/local/natinst/LabVIEW-2026-64/labview';
const CFG = '/usr/local/natinst/share/nilvcli/Examples/LabVIEWCLIExampleProject/ConfigFile.viancfg';
const CONFIG_NAME = 'LabVIEWCLIExampleProject';
const SSH = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=8'];
const viaCmd = (report) => `timeout 240 xvfb-run -a ${LVCLI} -LabVIEWPath ${LVP} -OperationName RunVIAnalyzer -ConfigPath ${CFG} -ReportPath ${report} -ReportSaveType ASCII`;

function discoverPlanes() {
  const planes = [];
  if (existsSync(LVCLI)) planes.push({ instance: 'host', dispatch: 'local', hostname: hostname() });
  try {
    const vms = execFileSync('VBoxManage', ['list', 'runningvms'], { encoding: 'utf8' }).split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean);
    for (const vm of vms) {
      const info = execFileSync('VBoxManage', ['showvminfo', vm, '--machinereadable'], { encoding: 'utf8' });
      const port = (info.match(/Forwarding\(\d+\)="ssh,tcp,[^,]*,(\d+),,22"/) || [])[1];
      if (!port) continue;
      const chk = spawnSync('ssh', ['-p', port, ...SSH, 'actor@127.0.0.1', `ls ${LVCLI} 2>/dev/null`], { encoding: 'utf8', timeout: 20000 });
      if ((chk.stdout || '').includes('LabVIEWCLI')) planes.push({ instance: `vm:${vm}`, dispatch: 'ssh', port });
    }
  } catch (e) { console.error(`  (VM discovery skipped: ${e.message})`); }
  return planes;
}

// Parse the Linux LabVIEWCLI RunVIAnalyzer ASCII report (tab-separated "Label<TAB>count" rows) into the
// normalized shape summarizeViAnalyzerReport expects. The shipped LabVIEWCLIExampleProject is all-pass, so
// the "Failed Tests (sorted by VI)" section is "(none)" and findings is empty.
function parseLinuxViaReport(text) {
  const num = (label) => { const m = String(text).match(new RegExp('^' + label + '\\s+(\\d+)\\s*$', 'm')); return m ? Number(m[1]) : 0; };
  const passed = num('Passed Tests');
  const failed = num('Failed Tests');
  const skipped = num('Skipped Tests');
  const error = num('VI not loadable') + num('Test not loadable') + num('Test not runnable') + num('Test error out');
  return { config: CONFIG_NAME, summary: { passed, failed, error, skipped, unloadable: 0 }, findings: [] };
}

// Run VI Analyzer on a plane and return { instance, hostname, reportText }.
function runViAnalyzer(plane) {
  if (plane.dispatch === 'local') {
    spawnSync('bash', ['-c', viaCmd('/tmp/via-host.txt')], { encoding: 'utf8', timeout: 260000 });
    return { instance: plane.instance, hostname: plane.hostname, reportText: existsSync('/tmp/via-host.txt') ? readFileSync('/tmp/via-host.txt', 'utf8') : '' };
  }
  const remote = `echo "HOST:$(hostname)"; ${viaCmd('/tmp/via-vm.txt')} >/dev/null 2>&1; echo "===VIA-START==="; cat /tmp/via-vm.txt; echo "===VIA-END==="`;
  const r = spawnSync('ssh', ['-p', plane.port, ...SSH, 'actor@127.0.0.1', remote], { encoding: 'utf8', timeout: 280000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/===VIA-START===\r?\n([\s\S]*?)\r?\n===VIA-END===/);
  return { instance: plane.instance, hostname: (out.match(/HOST:(\S+)/) || [])[1] || plane.instance, reportText: m ? m[1] : '' };
}

const planes = discoverPlanes();
console.log(`LabVIEW planes: ${planes.map((p) => p.instance).join(', ')}`);
if (planes.length < 2) { console.error('need >= 2 LabVIEW planes'); process.exit(1); }

const runs = await Promise.all(planes.map((p) => Promise.resolve().then(() => runViAnalyzer(p))));
const summarized = runs.map((r) => {
  const report = parseLinuxViaReport(r.reportText);
  const summary = summarizeViAnalyzerReport(report);
  return { instance: r.instance, hostname: r.hostname, os: 'linux', summary };
});

const receipt = buildComparisonReceipt({ benchmark: `vi-analyzer ${CONFIG_NAME}`, planes: summarized });
const v = validateComparison(receipt);
mkdirSync(join(here, 'fixtures'), { recursive: true });
writeFileSync(join(here, 'fixtures', 'cross-plane-comparison-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');

for (const p of receipt.planes) console.log(`  ${p.instance} [${p.hostname}] ${p.totalTests} tests, ${p.totalFindings} findings, resultHash ${p.resultHash.slice(0, 16)}…`);
console.log(`cross-plane comparison: ${receipt.planeCount} planes, resultHashesMatch=${receipt.resultHashesMatch} (consensus ${receipt.consensusHash ? receipt.consensusHash.slice(0, 16) + '…' : 'NONE'}); valid=${v.ok}${v.ok ? '' : ' findings=' + v.findings.join('; ')}`);
