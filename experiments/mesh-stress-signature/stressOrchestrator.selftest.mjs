// Self-test for stressOrchestrator.mjs -- the COMMANDED side of the mesh ladder: monotone levels, the throttle +
// workload command generation, and a ladder plan that pins each actor to a DIFFERENT level. Deterministic.
// Run: node stressOrchestrator.selftest.mjs  (exit 0 = all pass).

import assert from 'node:assert/strict';
import {
  MESH_STRESS_LEVELS, LEVEL_COMMANDS, levelCommand, vboxThrottleCommands,
  guestWorkloadCommand, hostStressCommand, buildLadderPlan, MESH_ORCHESTRATOR_SCHEMA
} from './stressOrchestrator.mjs';

let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };

// --- the commanded ladder is MONOTONE (cap decreases, workload increases) ---
{
  const caps = MESH_STRESS_LEVELS.map((l) => LEVEL_COMMANDS[l].cpuExecutionCap);
  const workers = MESH_STRESS_LEVELS.map((l) => LEVEL_COMMANDS[l].workloadWorkers);
  for (let i = 1; i < caps.length; i += 1) {
    assert.ok(caps[i] < caps[i - 1], `cpuExecutionCap strictly decreases (${caps[i - 1]} -> ${caps[i]})`);
    assert.ok(workers[i] >= workers[i - 1], 'workloadWorkers non-decreasing');
  }
  assert.equal(caps[0], 100, 'idle is uncapped');
  assert.equal(workers[0], 0, 'idle runs no workload');
  assert.ok(workers[workers.length - 1] > workers[1], 'saturate loads more than light');
  ok(`monotone commanded ladder: caps [${caps.join(', ')}], workers [${workers.join(', ')}]`);
}

// --- level lookup by name + index ---
{
  assert.equal(levelCommand('medium'), LEVEL_COMMANDS.medium);
  assert.equal(levelCommand(2), LEVEL_COMMANDS.medium, 'level index 2 = medium');
  assert.throws(() => levelCommand('nope'), 'unknown level throws');
  assert.throws(() => levelCommand(9), 'out-of-range level index throws');
  ok('level lookup by name + index (+ guards)');
}

// --- VirtualBox throttle commands ---
{
  const cmds = vboxThrottleCommands('actor-linux-03', 'heavy');
  assert.ok(cmds.some((c) => /modifyvm actor-linux-03 --cpuexecutioncap 40\b/.test(c)), 'sets the CPU execution cap for the level');
  assert.ok(cmds.some((c) => /bandwidthctl .* --limit 50M/.test(c)), 'adds the IO bandwidth limit for the level');
  assert.equal(vboxThrottleCommands('a', 'idle').length, 1, 'idle only caps CPU (no IO limit)');
  assert.throws(() => vboxThrottleCommands('', 'idle'), 'missing vmName throws');
  ok('vbox throttle commands: cpuexecutioncap + bandwidthctl per level');
}

// --- workload + host stress commands ---
{
  assert.equal(guestWorkloadCommand('idle'), null, 'idle runs no in-guest workload');
  const sat = guestWorkloadCommand('saturate', 30);
  assert.ok(/stress-ng/.test(sat) && /--cpu 8/.test(sat) && /--hdd/.test(sat) && /--vm 1/.test(sat) && /--timeout 30s/.test(sat), 'saturate workload spans cpu+io+vm');
  const host = hostStressCommand({ cpuWorkers: 6, timeoutSec: 90 });
  assert.ok(/stress-ng --cpu 6 /.test(host) && /--timeout 90s/.test(host), 'host stress command is well-formed');
  ok('workload + host stress commands generated');
}

// --- ladder plan pins each actor to a DIFFERENT level ---
{
  const plan5 = buildLadderPlan({ meshSize: 5, plane: 'LINUX' });
  assert.equal(plan5.schema, MESH_ORCHESTRATOR_SCHEMA);
  assert.equal(plan5.actors.length, 5);
  assert.deepEqual(plan5.actors.map((a) => a.level), ['idle', 'light', 'medium', 'heavy', 'saturate'], 'a 5-actor mesh spans the whole ladder, one level each');
  assert.equal(new Set(plan5.actors.map((a) => a.level)).size, 5, 'all five actors are pinned to DIFFERENT levels');
  assert.ok(plan5.actors.every((a) => a.throttle.length >= 1 && (a.level === 'idle' || a.workload)), 'each actor carries its throttle + workload');

  const plan3 = buildLadderPlan({ meshSize: 3, plane: 'WIN' });
  assert.deepEqual(plan3.actors.map((a) => a.level), ['idle', 'medium', 'saturate'], 'a 3-actor mesh spreads across the ladder (endpoints + middle)');
  assert.ok(plan3.actors.every((a) => a.name.startsWith('actor-win-')), 'actor names carry the plane');
  assert.throws(() => buildLadderPlan({ meshSize: 0 }), 'meshSize 0 throws');
  ok(`ladder plan: 5-actor -> [${plan5.actors.map((a) => a.level).join(', ')}]; 3-actor -> [${plan3.actors.map((a) => a.level).join(', ')}]`);
}

console.log(`\nstressOrchestrator.selftest: ${passed}/${passed} checks passed`);
