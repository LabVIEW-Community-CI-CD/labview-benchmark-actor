// labview-benchmark-actor -- mesh-stress ORCHESTRATOR (mesh-stress-signature@v1, the COMMANDED side of the ladder).
//
// Defines the stress LADDER's commanded levels (idle -> saturate) and generates the throttle + workload commands
// that PIN each actor to a level: a per-actor VirtualBox CPU execution cap (--cpuexecutioncap) + IO bandwidth
// limit (--bandwidthctl), a per-actor in-guest stress-ng workload, and the background HOST stress-ng load. In one
// acquisition each actor is pinned to a DIFFERENT level (a horizontal slice across the ladder). The commanded
// levels are MONOTONE (cap decreases, workload increases with the rung) so the calibrator can compare COMMANDED
// vs MEASURED. Pure, dependency-free ESM, deterministic -- it emits the plan/commands; a live runner applies them.

export const MESH_ORCHESTRATOR_SCHEMA = 'labview-benchmark-actor/mesh-stress-orchestrator@v1';
export const MESH_STRESS_LEVELS = Object.freeze(['idle', 'light', 'medium', 'heavy', 'saturate']);

// Commanded throttle + workload per level. MONOTONE by construction: cpuExecutionCap strictly decreases and the
// workload strictly increases from idle to saturate, so a salient counter measured under it must track the rung.
export const LEVEL_COMMANDS = Object.freeze({
  idle: { level: 0, cpuExecutionCap: 100, ioBandwidthMBps: null, workloadWorkers: 0, stressClass: 'none' },
  light: { level: 1, cpuExecutionCap: 80, ioBandwidthMBps: 200, workloadWorkers: 1, stressClass: 'cpu' },
  medium: { level: 2, cpuExecutionCap: 60, ioBandwidthMBps: 100, workloadWorkers: 2, stressClass: 'cpu+io' },
  heavy: { level: 3, cpuExecutionCap: 40, ioBandwidthMBps: 50, workloadWorkers: 4, stressClass: 'cpu+io+vm' },
  saturate: { level: 4, cpuExecutionCap: 20, ioBandwidthMBps: 25, workloadWorkers: 8, stressClass: 'cpu+io+vm' }
});

function levelName(levelOrName) {
  if (typeof levelOrName === 'string' && LEVEL_COMMANDS[levelOrName]) return levelOrName;
  if (typeof levelOrName === 'number') {
    const n = MESH_STRESS_LEVELS[levelOrName];
    if (n) return n;
  }
  throw new Error(`unknown stress level: ${levelOrName}`);
}

/** The commanded spec for a level (name or 0..4 index). */
export function levelCommand(levelOrName) {
  return LEVEL_COMMANDS[levelName(levelOrName)];
}

/** VirtualBox throttle commands pinning a VM to a level (CPU cap + IO bandwidth limit). */
export function vboxThrottleCommands(vmName, levelOrName) {
  if (!vmName || typeof vmName !== 'string') throw new Error('vboxThrottleCommands requires a vmName.');
  const c = levelCommand(levelOrName);
  const cmds = [`VBoxManage modifyvm ${vmName} --cpuexecutioncap ${c.cpuExecutionCap}`];
  if (c.ioBandwidthMBps != null) {
    cmds.push(`VBoxManage bandwidthctl ${vmName} add lba-io --type disk --limit ${c.ioBandwidthMBps}M`);
    cmds.push(`VBoxManage storageattach ${vmName} --storagectl SATA --port 0 --device 0 --type hdd --bandwidthgroup lba-io`);
  }
  return cmds;
}

/** In-guest stress-ng workload command for a level (empty when idle). */
export function guestWorkloadCommand(levelOrName, timeoutSec = 60) {
  const c = levelCommand(levelOrName);
  if (c.workloadWorkers === 0) return null;
  const parts = ['stress-ng', '--timeout', `${timeoutSec}s`, '--metrics-brief', '--cpu', String(c.workloadWorkers)];
  if (c.stressClass.includes('io')) parts.push('--hdd', String(Math.max(1, Math.floor(c.workloadWorkers / 2))));
  if (c.stressClass.includes('vm')) parts.push('--vm', '1', '--vm-bytes', '512M');
  return parts.join(' ');
}

/** Background HOST stress-ng load so the mesh measures itself on a loaded host. */
export function hostStressCommand({ cpuWorkers = 4, vmWorkers = 2, hddWorkers = 1, timeoutSec = 120 } = {}) {
  return `stress-ng --cpu ${cpuWorkers} --vm ${vmWorkers} --vm-bytes 1G --hdd ${hddWorkers} --timeout ${timeoutSec}s --metrics-brief`;
}

/**
 * Build a ladder acquisition plan: pin each of meshSize actors to a DIFFERENT level (a horizontal slice). When
 * meshSize < 5 the levels are spread across the ladder (endpoints kept); when > 5 they wrap round-robin.
 * @param {object} opts { meshSize, plane:'LINUX'|'WIN', actorPrefix='actor', host? }
 */
export function buildLadderPlan(opts = {}) {
  const meshSize = opts.meshSize;
  if (!(Number.isInteger(meshSize) && meshSize >= 1)) throw new Error('buildLadderPlan requires meshSize >= 1.');
  const plane = opts.plane || 'LINUX';
  const prefix = opts.actorPrefix || 'actor';

  // choose a level index per actor: spread across [0..4] so distinct levels are used (endpoints kept for <=5).
  const levelsForActors = [];
  for (let i = 0; i < meshSize; i += 1) {
    const idx = meshSize === 1 ? 0 : Math.round((i * (MESH_STRESS_LEVELS.length - 1)) / (Math.min(meshSize, MESH_STRESS_LEVELS.length) - 1 || 1));
    levelsForActors.push(Math.min(MESH_STRESS_LEVELS.length - 1, meshSize <= MESH_STRESS_LEVELS.length ? idx : i % MESH_STRESS_LEVELS.length));
  }

  const actors = levelsForActors.map((li, i) => {
    const name = `${prefix}-${plane.toLowerCase()}-${String(i).padStart(2, '0')}`;
    const level = MESH_STRESS_LEVELS[li];
    return {
      name,
      plane,
      level,
      commanded: LEVEL_COMMANDS[level],
      throttle: vboxThrottleCommands(name, level),
      workload: guestWorkloadCommand(level)
    };
  });

  return {
    schema: MESH_ORCHESTRATOR_SCHEMA,
    plane,
    meshSize,
    host: opts.host || null,
    hostStress: hostStressCommand(),
    levelsUsed: [...new Set(actors.map((a) => a.level))],
    actors
  };
}
