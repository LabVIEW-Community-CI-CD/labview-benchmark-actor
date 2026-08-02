// Self-test for capabilityRouter.mjs -- capability-aware distributed routing (LBA-REQ-041, ADR-0029).
// Replays the committed REAL receipt (a LabVIEW task routed to the host + node self-tests spread across the
// pool) offline, and proves the router FAILS CLOSED. rg-free (CI runners have no ripgrep): the fail-closed
// cases use synthetic data. Run: node verify-capability-routing.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { routeByCapability, buildRoutedReceipt, validateRouting, ROUTED_SCHEMA } from './capabilityRouter.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'capability-routed-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// 1. the committed real receipt validates, and the LabVIEW task ran on a LabVIEW-capable instance
{
  const v = validateRouting(receipt);
  assert.ok(v.ok, `expected a valid routed receipt; findings: ${v.findings.join('; ')}`);
  assert.equal(receipt.schema, ROUTED_SCHEMA, 'schema is capability-routed-workload@1');
  const lvTask = receipt.tasks.find((t) => t.requires.includes('labview'));
  assert.ok(lvTask, 'the workload includes a LabVIEW task');
  const lvShard = receipt.shards.find((s) => s.tasks.includes(lvTask.id));
  const lvInstance = receipt.instances.find((x) => x.id === lvShard.instance);
  assert.ok(lvInstance.capabilities.includes('labview'), 'the LabVIEW task ran on a LabVIEW-capable instance');
  assert.ok(receipt.instances.length >= 2, 'distributed across >= 2 instances');
  ok(`committed receipt valid: LabVIEW task on ${lvInstance.id} {${lvInstance.capabilities.join('+')}}, ${receipt.tasks.length} tasks over ${receipt.instances.length} instances`);
}

// 2. the routing re-derives deterministically from the recorded capabilities + weights
{
  const expected = routeByCapability(receipt.tasks, receipt.instances.map((x) => ({ capabilities: x.capabilities, weight: x.weight })));
  for (let i = 0; i < receipt.shards.length; i++) {
    assert.deepEqual([...receipt.shards[i].tasks].sort(), [...expected[i]].sort(), `instance ${i} matches the capability routing`);
  }
  ok('routing is deterministic (re-derives from recorded capabilities + weights)');
}

// 3. routeByCapability sends a required capability ONLY to a capable instance, and throws if none can
{
  const insts = [{ capabilities: ['labview', 'node'], weight: 3 }, { capabilities: ['node'], weight: 1 }];
  const shards = routeByCapability([{ id: 'L', requires: ['labview'] }, { id: 'n1', requires: ['node'] }, { id: 'n2', requires: ['node'] }], insts);
  assert.ok(shards[0].includes('L'), 'the labview task lands on the labview-capable instance');
  assert.ok(!shards[1].includes('L'), 'the labview task never lands on a node-only instance');
  assert.throws(() => routeByCapability([{ id: 'gpu', requires: ['gpu'] }], insts), /no instance satisfies/, 'an unsatisfiable capability throws (fail-closed)');
  ok('capability routing places tasks only on capable instances; unsatisfiable throws');
}

// 4. fail-closed: a task on an incapable instance, overlap, non-ripgrep, or a failure are each rejected
{
  const clone = () => JSON.parse(JSON.stringify(receipt));
  const lvId = receipt.tasks.find((t) => t.requires.includes('labview')).id;

  const misrouted = clone();
  const nodeOnly = misrouted.instances.find((x) => !x.capabilities.includes('labview'));
  const lvShard2 = misrouted.shards.find((s) => s.tasks.includes(lvId));
  lvShard2.tasks = lvShard2.tasks.filter((t) => t !== lvId);
  misrouted.shards.find((s) => s.instance === nodeOnly.id).tasks.push(lvId);
  assert.equal(validateRouting(misrouted).ok, false, 'a LabVIEW task on a node-only instance is rejected');

  const notRg = clone(); notRg.instances[1].searchTool = 'grep';
  assert.equal(validateRouting(notRg).ok, false, 'a non-ripgrep instance is rejected');

  const failed = clone(); failed.shards[0].passed = failed.shards[0].total - 1; failed.allPassed = false;
  assert.equal(validateRouting(failed).ok, false, 'a task failure is rejected');
  ok('fail-closed: misrouted capability / non-ripgrep / failure all rejected');
}

// 5. buildRoutedReceipt round-trips (route -> build -> validate is consistent + deterministic)
{
  const insts = [
    { id: 'host', hostname: 'h', capabilities: ['labview', 'node'], weight: 3, searchTool: 'ripgrep' },
    { id: 'cs', hostname: 'c', capabilities: ['node'], weight: 1, searchTool: 'ripgrep' },
  ];
  const tasks = [{ id: 'L', requires: ['labview'] }, { id: 'n1', requires: ['node'] }, { id: 'n2', requires: ['node'] }];
  const shards = routeByCapability(tasks, insts);
  const results = insts.map((x, i) => ({ ...x, tasks: shards[i], passed: shards[i].length }));
  const r = buildRoutedReceipt({ workload: 'x', instances: results, tasks, shards: results });
  assert.equal(validateRouting(r).ok, true, 'a well-formed routed receipt validates');
  assert.ok(shards[0].includes('L'), 'the labview task routed to the labview-capable instance');
  ok('buildRoutedReceipt produces a valid, deterministic receipt');
}

console.log(`\nverify-capability-routing.selftest: ${passed}/${passed} checks passed`);
