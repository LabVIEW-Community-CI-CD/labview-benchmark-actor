// Self-test for generate-test-report.mjs -- the ISO/IEC/IEEE 29119-3 test report + ISO 10007 status
// accounting GENERATOR (LBA-REQ-035). Proves (a) the COMMITTED report is CURRENT with the sources,
// (b) rendering is DETERMINISTIC (stable across runs, so `--check` is a reliable gate), and (c) the
// drift compare FAILS CLOSED -- any mutation of the committed text is detected.
// Run: node generate-test-report.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { renderReport, OUT_REL } from './generate-test-report.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed report is CURRENT with the canonical sources (what the `test-report-current` gate asserts)
{
  const { text, gates, rules, requirements, adrs, testItems } = renderReport({ repoRoot });
  const committed = readFileSync(join(repoRoot, OUT_REL), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, text, `${OUT_REL} is STALE -- run: node experiments/reqs-coverage/generate-test-report.mjs`);
  assert.ok(gates >= 100, `derives the full gate inventory (${gates} gates)`);
  assert.equal(rules, 7, `derives all 7 correspondence rules`);
  assert.ok(requirements >= 34, `derives the requirement register (${requirements} requirements)`);
  assert.ok(adrs >= 24, `derives the ADR register (${adrs} ADRs)`);
  assert.ok(testItems >= 34, `derives the test-item register (${testItems} test items)`);
  ok(`committed report current: ${gates} gates, ${rules} rules, ${requirements} reqs, ${adrs} ADRs, ${testItems} test items`);
}

// 2. deterministic: two renders of the same sources are byte-identical (no timestamps / ordering nondeterminism)
{
  const a = renderReport({ repoRoot }).text;
  const b = renderReport({ repoRoot }).text;
  assert.equal(a, b, 'the report must render identically across runs');
  ok('render is deterministic (byte-identical across runs)');
}

// 3. fail-closed: any mutation of the committed text is detected by the drift compare
{
  const { text } = renderReport({ repoRoot });
  const tampered = text.replace('fail-closed', 'FAIL-OPEN');
  assert.notEqual(tampered, text, 'a mutation must differ from the canonical render');
  assert.equal(tampered.replace(/\r\n/g, '\n') === text, false, 'the drift compare FAILS CLOSED on any mutation');
  ok('drift compare fails closed on any mutation of the report');
}

// 4. the report is a genuine 29119-3 + 10007 information item (completion criteria + status accounting present)
{
  const { text } = renderReport({ repoRoot });
  assert.ok(/Completion criteria/.test(text), 'states 29119-2 completion criteria');
  assert.ok(/Executed verification evidence/.test(text), 'records 29119-3 executed evidence');
  assert.ok(/Configuration status accounting/.test(text), 'records ISO 10007 status accounting');
  assert.ok(/Requirements \(total\)/.test(text), 'accounts the requirement configuration items');
  ok('report carries completion criteria + executed evidence + status accounting');
}

console.log(`\ngenerate-test-report.selftest: ${passed}/${passed} checks passed`);
