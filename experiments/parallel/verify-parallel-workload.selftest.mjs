// Self-test for parallelWorkload.mjs -- distributed parallel-workload proof (LBA-REQ-040, ADR-0028).
// Replays the committed REAL receipt (host + codespace ran disjoint self-test shards concurrently) offline
// -- no codespace, no network in CI. Proves (a) the receipt validates: the deterministic partition
// reproduces the shards, the shards are disjoint + cover every task, the instances are distinct, both
// searched with ripgrep, and every task passed; and (b) validation FAILS CLOSED on overlap, a shared
// instance, a non-ripgrep tool, or a shard failure. Run: node verify-parallel-workload.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { validateReceipt, capacityWeightedPartition, RECEIPT_SCHEMA } from './parallelWorkload.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'parallel-workload-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = () => JSON.parse(JSON.stringify(receipt));

// 1. the committed real receipt validates: disjoint parallel work across two rg-only instances, all passed
{
  const v = validateReceipt(receipt);
  assert.ok(v.ok, `expected a valid parallel-workload receipt; findings: ${v.findings.join('; ')}`);
  assert.equal(receipt.schema, RECEIPT_SCHEMA, 'schema is parallel-workload@1');
  assert.ok(receipt.shardCount >= 2 || receipt.instanceCount >= 2, 'at least two instances');
  assert.equal(v.instances.length, receipt.instanceCount, 'each shard ran on a distinct instance');
  assert.ok(receipt.tasks.length >= 20, `a substantial workload (${receipt.tasks.length} self-tests)`);
  assert.equal(receipt.allPassed, true, 'every task passed on both instances');
  ok(`committed receipt valid: ${receipt.totalTasks} self-tests across ${v.instances.length} instances (${v.instances.join(', ')})`);
}

// 2. the capacity-weighted partition (from the recorded per-instance weights) reproduces the assignment
{
  const expected = capacityWeightedPartition(receipt.tasks, receipt.shards.map((s) => ({ weight: s.weight })));
  for (let i = 0; i < receipt.instanceCount; i++) {
    assert.deepEqual([...receipt.shards[i].tasks].sort(), [...expected[i]].sort(), `instance ${i} matches the capacity-weighted split`);
  }
  ok('capacity-weighted partition is deterministic (re-derives the committed assignment from the recorded weights)');
}

// 3. both instances searched with ripgrep only (operator directive)
{
  for (const s of receipt.shards) assert.equal(s.searchTool, 'ripgrep', `shard ${s.shard} used ripgrep`);
  ok('both instances attest ripgrep-only search');
}

// 4. fail-closed: overlap, a shared instance, a non-ripgrep tool, or a failure are each rejected
{
  const overlap = clone(); overlap.shards[1].tasks = [...overlap.shards[1].tasks, overlap.shards[0].tasks[0]];
  assert.equal(validateReceipt(overlap).ok, false, 'overlapping shards are rejected');

  const sameHost = clone(); sameHost.shards[1].hostname = sameHost.shards[0].hostname;
  assert.equal(validateReceipt(sameHost).ok, false, 'shards on the same instance are rejected');

  const notRg = clone(); notRg.shards[1].searchTool = 'grep';
  assert.equal(validateReceipt(notRg).ok, false, 'a non-ripgrep search tool is rejected');

  const failed = clone(); failed.shards[0].passed = failed.shards[0].total - 1; failed.allPassed = false;
  assert.equal(validateReceipt(failed).ok, false, 'a shard failure is rejected');
  ok('fail-closed: overlap / shared instance / non-ripgrep / failure all rejected');
}

console.log(`\nverify-parallel-workload.selftest: ${passed}/${passed} checks passed`);
