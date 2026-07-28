#!/usr/bin/env node
// Cross-plane hardware-capability probe (hardware-utilization KPI): characterize the box THIS agent runs on --
// CPU cores/model, RAM, GPU(s)/VRAM, container runtime -- and write a receipt so BOTH planes KNOW their
// capabilities (not knowing them hurts the KPI) and the ~80%-average-usage target scales per box. Best-effort
// and cross-platform: node os.* is portable (works on the WIN plane too); nvidia-smi + docker are probed only
// if present (absent -> recorded as null, never fatal). This is a MAINTAINER capability record, not a CI gate
// (it is machine-specific / non-deterministic); each plane runs it on its own box.
//
// Usage: node experiments/hardware-capability/probe-hardware.mjs [--json] [--out <path>]

import os from 'node:os';
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function tryExec(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 }).toString().trim();
  } catch {
    return null;
  }
}

const cpus = os.cpus() || [];
const gpuRaw = tryExec('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader');
const gpus = gpuRaw
  ? gpuRaw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, memoryTotal] = l.split(',').map((s) => s.trim());
        return { name, memoryTotal };
      })
  : [];
const containerRuntime = tryExec('docker info --format "{{.OSType}}/{{.Architecture}} {{.NCPU}}cpu {{.MemTotal}}b"');

const logicalCores = cpus.length;
const capability = {
  schema: 'labview-benchmark-actor/hardware-capability@v1',
  probedAt: new Date().toISOString(),
  platform: `${os.platform()}-${os.arch()}`,
  cpu: {
    model: cpus[0]?.model?.trim() ?? null,
    logicalCores,
    speedMHzMax: cpus.reduce((m, c) => Math.max(m, c.speed || 0), 0) || null,
  },
  memory: { totalGiB: +(os.totalmem() / 2 ** 30).toFixed(1), freeGiB: +(os.freemem() / 2 ** 30).toFixed(1) },
  gpus,
  containerRuntime,
  loadAvg1m: +(os.loadavg()[0] ?? 0).toFixed(2),
  // The parallelism budget the ~80%-average-usage target scales to: run CPU work (docker/stress/builds) IN
  // PARALLEL with GPU work (ollama) so both lanes load the box at once.
  parallelismBudget: {
    cpuWorkers: Math.max(1, logicalCores - 1),
    gpuLanes: gpus.length,
    guidance:
      'Aim ~80% average across CPU workers + GPU lane(s); run CPU work (docker / stress harness / builds) ' +
      'concurrently with GPU work (ollama sweeps) -- docker can run alongside vagrant + native.',
  },
};

const outIdx = process.argv.indexOf('--out');
const out = outIdx >= 0 && process.argv[outIdx + 1] ? process.argv[outIdx + 1] : join(here, 'capability-receipt.json');
writeFileSync(resolve(process.cwd(), out), `${JSON.stringify(capability, null, 2)}\n`);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(capability, null, 2));
} else {
  console.log(
    `hardware-capability: ${capability.platform} | ${logicalCores} cores (${capability.cpu.model}) | ` +
      `${capability.memory.totalGiB}GiB RAM | GPU: ${gpus.map((g) => `${g.name} ${g.memoryTotal}`).join('; ') || 'none'} | ` +
      `container: ${containerRuntime || 'none'}`
  );
  console.log(`parallelism budget: ${capability.parallelismBudget.cpuWorkers} CPU workers + ${capability.parallelismBudget.gpuLanes} GPU lane(s)`);
  console.log(`wrote receipt -> ${out}`);
}
