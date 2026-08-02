// Self-test for verify-information-for-users.mjs -- the ISO/IEC/IEEE 26514:2022 information-for-users conformance
// gate (LBA-REQ-034). Proves (a) the COMMITTED set is conformant and covers the full command surface, and
// (b) the checker FAILS CLOSED -- an empty set flags every missing item and any uncovered command.
// Run: node verify-information-for-users.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildInformationForUsersReport, REQUIRED_ITEMS } from './verify-information-for-users.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed set is conformant + covers every contributed command
{
  const r = buildInformationForUsersReport({ repoRoot });
  assert.ok(r.ok, `expected the committed set to be conformant; findings: ${r.findings.join('; ')}`);
  assert.equal(r.commandsCovered, r.commandsTotal, 'the command reference covers every contributed command');
  assert.ok(r.commandsTotal >= 20, `covers the full command surface (${r.commandsTotal} commands)`);
  assert.equal(r.requiredItems, REQUIRED_ITEMS.length, 'all required information items are defined');
  ok(`committed set conformant: ${r.requiredItems} items, ${r.commandsCovered}/${r.commandsTotal} commands covered`);
}

// 2. fail-closed: an empty set flags every required item + any uncovered command
{
  const tmp = mkdtempSync(join(tmpdir(), 'lba-26514-'));
  try {
    mkdirSync(join(tmp, 'docs', 'information-for-users'), { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ contributes: { commands: [{ command: 'x', title: 'LabVIEW Benchmark Actor: Ghost Command' }] } }));
    const r = buildInformationForUsersReport({ repoRoot: tmp });
    assert.equal(r.ok, false, 'an empty information-for-users set must FAIL closed');
    for (const name of REQUIRED_ITEMS) assert.ok(r.findings.some((f) => f.includes(`${name}.md`)), `flags the missing ${name}.md`);
    assert.ok(r.findings.some((f) => f.includes('Ghost Command')), 'flags the command the reference does not cover');
    ok(`fail-closed on an empty set (${r.findings.length} findings: every missing item + the uncovered command)`);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`\nverify-information-for-users.selftest: ${passed}/${passed} checks passed`);
