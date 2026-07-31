#!/usr/bin/env node
// Parametrized coverage gate + ratchet for the "PR Coverage Gate" (LBA-REQ-016 / ISO/IEC/IEEE 29119).
//
// The coverage floors live in coverage-thresholds.json (the single parametrized knob). This runs the
// extension test suite under c8 with those floors as fail-under thresholds and emits a Cobertura
// coverage.xml (coverage/cobertura-coverage.xml, the retained coverage artifact). With `--bump` it
// RATCHETS the floors UPWARD toward the measured coverage (by at most `step` per bump, capped at
// `target`) so the thresholds increase gradually and never regress.
//
// Usage:
//   node scripts/coverage.mjs           # run + enforce the current floors (the gate)
//   node scripts/coverage.mjs --bump    # run + enforce, then ratchet the floors up toward measured
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfgPath = join(repo, 'coverage-thresholds.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const bump = process.argv.includes('--bump');

for (const m of METRICS) {
  if (typeof cfg.floor?.[m] !== 'number') {
    console.error(`coverage: floor.${m} missing in coverage-thresholds.json`);
    process.exit(2);
  }
}

// Run the suite under c8 with the parametrized floors as fail-under thresholds.
const args = [
  'c8', '--check-coverage',
  ...METRICS.flatMap((m) => [`--${m}`, String(cfg.floor[m])]),
  '--reporter=cobertura', '--reporter=json-summary', '--reporter=text-summary',
  'npm', 'test',
];
const run = spawnSync('npx', args, { cwd: repo, stdio: 'inherit' });
if (run.status !== 0) {
  process.exit(run.status ?? 1);
}

// Read the measured totals (json-summary reporter) to report headroom and (optionally) ratchet.
const summary = JSON.parse(readFileSync(join(repo, 'coverage', 'coverage-summary.json'), 'utf8')).total;
const measured = Object.fromEntries(METRICS.map((m) => [m, summary[m].pct]));
console.log(`coverage floors ${JSON.stringify(cfg.floor)} | measured ${JSON.stringify(measured)}`);

if (!bump) {
  process.exit(0);
}

// Ratchet each floor UP toward measured, by at most `step`, capped at `target` AND a `buffer` below the
// measured coverage (conservative headroom so normal variance never trips the required gate); never lower.
const step = cfg.step ?? 1;
const buffer = cfg.buffer ?? 0;
let changed = false;
for (const m of METRICS) {
  const cur = cfg.floor[m];
  const cap = Math.min(Math.floor(measured[m]) - buffer, cfg.target?.[m] ?? 100);
  const next = Math.min(cur + step, cap);
  if (next > cur) {
    cfg.floor[m] = next;
    changed = true;
    console.log(`ratchet ${m}: ${cur} -> ${next} (measured ${measured[m]}%, target ${cfg.target?.[m]}%)`);
  } else {
    console.log(`hold ${m}: ${cur} (measured ${measured[m]}%, cap ${cap}%)`);
  }
}
if (changed) {
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log('updated coverage-thresholds.json (floors ratcheted up)');
} else {
  console.log('no ratchet: floors already at the measured/target ceiling');
}
