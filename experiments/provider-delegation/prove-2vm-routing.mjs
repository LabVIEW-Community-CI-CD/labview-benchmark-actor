#!/usr/bin/env node
// LIVE cross-machine routing proof across TWO REAL cleanroom VMs (not a mock loopback). The host router
// discovers two genuinely-different VirtualBox VMs over the bus, learns their capabilities, and routes by
// capability -- then dispatches a task to EACH real VM end-to-end (CLAIM -> ACK -> DONE) over NAT.
//
//   base  VM (lba-ubuntu2404-labview2026-scratch, SSH 2222) worker 127.0.0.1:7440 -- HAS ffmpeg + LabVIEWCLI
//   clone VM (lba-cleanroom-clone-01, linked clone, SSH 2223) worker 127.0.0.1:7441 -- LabVIEWCLI, NO ffmpeg
//
// The clone was spun up by linked-cloning the base's `mesh-node-ready` snapshot; it genuinely lacks ffmpeg
// (the snapshot predates the base's ffmpeg install), so an ffmpeg risky-test MUST route to the base only.
// Guests reach the host observer at the NAT gateway 10.0.2.2 (replyHost). Writes a receipt. Not a gate (needs
// the live VMs); this is committed EVIDENCE like vm-run-evidence.json.

import fs from 'node:fs';
import assert from 'node:assert';
import { discover, capable, route, requiredCapabilities } from './registry.mjs';
import { dispatchClaim } from './coordinator.mjs';
import { TASK_SCHEMA } from './delegateUplift.mjs';

const BASE = process.env.LBA_BASE_WORKER || '127.0.0.1:7440';
const CLONE = process.env.LBA_CLONE_WORKER || '127.0.0.1:7441';
const REPLY_HOST = process.env.LBA_REPLY_HOST || '10.0.2.2'; // NAT gateway: how a guest reaches the host
const OBSERVE_PORT = Number(process.env.LBA_OBSERVE_PORT || 7420);

let pass = 0;
const ok = (c, m) => { assert(c, m); pass += 1; console.log(`  ok: ${m}`); };

console.log(`[2vm] discovering real VM workers ${BASE} (base) + ${CLONE} (clone)...`);
const reg = await discover([BASE, CLONE], { timeoutMs: 6000 });
const byAddr = (a) => reg.find((w) => w.address === a);
const base = byAddr(BASE);
const clone = byAddr(CLONE);

// 1) both real VMs discovered live over the bus
ok(reg.length === 2 && base && clone, `both real VM workers answered the bus HELLO->READY (found ${reg.length})`);
ok(base.caps.agent === 'cleanroom-base' && clone.caps.agent === 'cleanroom-clone', `each VM advertised its identity (${base?.caps.agent}, ${clone?.caps.agent})`);

// 2) GENUINE capability difference between the two real machines
ok(base.caps.tools.ffmpeg === true, 'base VM advertises ffmpeg=true (real /usr/bin/ffmpeg)');
ok(clone.caps.tools.ffmpeg === false, 'clone VM advertises ffmpeg=false (genuinely absent on the snapshot)');
ok(base.caps.tools.LabVIEWCLI === true && clone.caps.tools.LabVIEWCLI === true, 'both VMs advertise LabVIEWCLI=true (real /usr/local/bin/LabVIEWCLI)');
ok(base.caps.tools.node === true && clone.caps.tools.node === true, 'both VMs advertise node=true');

// 3) CAPABILITY ROUTING: an ffmpeg risky-test is capable ONLY on the base VM
const ffTask = { schema: TASK_SCHEMA, domain: 'risky-test', id: 'T-2VM-FF', tool: 'ffmpeg', brief: 'exercise ffmpeg' };
ok(requiredCapabilities(ffTask).tool === 'ffmpeg', 'the ffmpeg risky-test requires the ffmpeg tool');
ok(capable(base, ffTask) === true && capable(clone, ffTask) === false, 'ffmpeg risky-test is capable on the base VM, NOT the clone');
const ffPick = route(reg, ffTask, { i: 0 });
ok(ffPick && ffPick.caps.agent === 'cleanroom-base', 'the router sends the ffmpeg risky-test to the base VM ONLY (clone excluded by capability)');

// 4) LOAD-BALANCE: a capability-free doc task round-robins across both real VMs
const cursor = { i: 0 };
const docOf = (id) => ({ schema: TASK_SCHEMA, domain: 'doc-draft', id, brief: 'note', requiredSections: [], minChars: 20 });
const picks = [route(reg, docOf('T-A'), cursor).caps.agent, route(reg, docOf('T-B'), cursor).caps.agent];
ok(new Set(picks).size === 2, `a capability-free batch round-robins across BOTH real VMs (${picks.join(', ')})`);

// 5) END-TO-END dispatch to EACH real VM (CLAIM -> ACK -> DONE over NAT; guest replies to 10.0.2.2)
console.log(`[2vm] dispatching a doc-draft to each real VM (reply via ${REPLY_HOST}:${OBSERVE_PORT})...`);
const dispatched = [];
for (const [label, addr] of [['base', BASE], ['clone', CLONE]]) {
  const task = docOf(`T-2VM-${label.toUpperCase()}`);
  // eslint-disable-next-line no-await-in-loop -- sequential keeps the single observer port free + is gentle on the pool
  const ev = await dispatchClaim({ worker: addr, taskSpec: task, replyHost: REPLY_HOST, observePort: OBSERVE_PORT, timeoutMs: 60000 });
  const verdict = ev.done ? ev.done.verdict : 'none';
  dispatched.push({ vm: label, worker: addr, id: task.id, claimed: !!ev.ack, verdict, agent: ev.done?.task?.provider || label });
  ok(!!ev.ack && verdict === 'pass', `${label} VM CLAIMED + ran the task end-to-end -> DONE verdict=pass`);
}

const receipt = {
  schema: 'labview-benchmark-actor/lba-cross-machine-2vm-routing@v1',
  ranAt: new Date().toISOString(),
  transport: 'lbabus-msg@1 over VirtualBox NAT (host<->2 guest VMs)',
  vms: [
    { role: 'base', worker: BASE, ssh: '127.0.0.1:2222', vm: 'lba-ubuntu2404-labview2026-scratch', caps: base.caps.tools },
    { role: 'clone', worker: CLONE, ssh: '127.0.0.1:2223', vm: 'lba-cleanroom-clone-01 (linked clone of mesh-node-ready)', caps: clone.caps.tools },
  ],
  capabilityDifference: { base_ffmpeg: base.caps.tools.ffmpeg, clone_ffmpeg: clone.caps.tools.ffmpeg },
  routing: { ffmpeg_risky_test_routed_to: ffPick.caps.agent, load_balance_picks: picks },
  dispatched,
  assertions: pass,
};
fs.writeFileSync(new URL('./cross-machine-2vm-routing-evidence.json', import.meta.url), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(`\nprove-2vm-routing: PASS (${pass} assertions) -- 2 REAL VMs, capability-differentiated routing + end-to-end dispatch to each. Receipt written.`);
