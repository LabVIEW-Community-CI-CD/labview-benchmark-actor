#!/usr/bin/env node
// OLLAMA BUS AGENT (operator architecture 2026-07-28): the big AI agent (Claude / WIN's agent) iterates the
// ollama ENGINE (the lba-coordinator model -- the governed, lesson-store-backed layer that gets constantly
// iterated); the ENGINE handles the BUS. The big agents no longer hand-write bus messages. Instead each plane's
// ollama READS the other plane's ollama posts via collab-cli (lbabus) and GENERATES + POSTS the coordination
// reply, governed by its banked lesson store. The big agent sets the INTENT and iterates the model's voice.
//
//   big agent (Claude) --intent + iterate model--> lba-coordinator (ollama) --collab-cli--> bus <--> WIN ollama
//
// Usage: node bus-agent.mjs "<intent>" [--type NOTE|PROGRESS|DONE] [--tail N] [--prio P2] [--post]
//   Dry-run by default (generate + print so the big agent can review/iterate the engine); --post sends it.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LBABUS = process.env.LBABUS_BIN || join(homedir(), '.dotnet', 'tools', 'lbabus');
const AGENT = process.env.VIHS_COLLAB_AGENT || 'LINUX';
const PEER = AGENT === 'LINUX' ? 'WIN' : 'LINUX';
const MODEL = process.env.OLLAMA_MODEL || 'lba-coordinator';
const OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const doPost = argv.includes('--post');
const type = flag('--type', 'NOTE');
const tail = flag('--tail', '3');
const prio = flag('--prio', 'P2');
const consumed = new Set(['--type', '--tail', '--prio']);
const intent = argv
  .filter((a, i) => !a.startsWith('--') && !consumed.has(argv[i - 1]))
  .join(' ')
  .trim();
if (!intent) {
  console.error('usage: bus-agent.mjs "<intent>" [--type NOTE|PROGRESS|DONE] [--tail N] [--prio P2] [--post]');
  process.exit(2);
}

// collab-cli env: fail-closed keyring auth (unset ambient tokens), roll-forward, the shared bus identity.
const busEnv = {
  ...process.env,
  DOTNET_ROLL_FORWARD: 'LatestMajor',
  VIHS_COLLAB_AGENT: AGENT,
  VIHS_COLLAB_REPO: process.env.VIHS_COLLAB_REPO || 'labview-benchmark-actor',
  VIHS_COLLAB_TITLE: process.env.VIHS_COLLAB_TITLE || 'labview-benchmark-actor coordination bus (WIN <-> LINUX)',
};
delete busEnv.GH_TOKEN;
delete busEnv.GITHUB_TOKEN;
delete busEnv.LBABUS_GITHUB_API;
const lbabus = (a) => execFileSync(LBABUS, a, { env: busEnv, encoding: 'utf8', maxBuffer: 1 << 20 });

// 1. READ the bus via collab-cli: the peer plane's ollama posts.
let recent = '';
try {
  recent = lbabus(['poll', '--full', '--agent', PEER, '--tail', String(tail)]);
} catch (err) {
  recent = `(bus read failed: ${err.message})`;
}

// 2. GENERATE via the ollama ENGINE (lba-coordinator: lesson-store-governed, bus-aware).
const prompt =
  `You are the ${AGENT}-plane bus agent for the labview-benchmark-actor cross-plane coordination bus (lbabus). ` +
  `The ${PEER} plane's ollama posted recently:\n${recent}\n\n` +
  `The big AI agent driving you set this INTENT: ${intent}\n\n` +
  `Write ONE concise ASCII coordination message (<= 500 chars) to post to ${PEER}. Apply a banked lesson if ` +
  `relevant. No preamble, no quotes, no markdown, no code fences -- just the message body.`;

const res = await fetch(`${OLLAMA}/api/generate`, {
  method: 'POST',
  body: JSON.stringify({ model: MODEL, prompt, stream: false, options: { num_ctx: 8192 } }),
});
const j = await res.json();
// Sanitize to a single ASCII line the bus accepts (no CR/LF, no quotes/backticks/$/!/apostrophes).
const msg = String(j.response || '')
  .replace(/[\r\n]+/g, ' ')
  .replace(/[\x60"'$!]/g, '')
  .replace(/[^\x20-\x7E]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 900);
if (!msg) {
  console.error('engine produced no message');
  process.exit(1);
}

console.log(`[${AGENT} bus-agent] engine(${MODEL}) generated a ${type}/${prio} to ${PEER}:`);
console.log(msg);

// 3. POST via collab-cli -- only with --post (dry-run otherwise, so the big agent reviews / iterates the engine).
if (doPost) {
  const out = lbabus(['post', '--type', type, '--to', PEER, '--priority', prio, '--message', msg]);
  console.log(`\nposted -> ${(out.trim().split('\n').pop() || '').trim()}`);
} else {
  console.log('\n(dry-run -- add --post to send; iterate the lba-coordinator model to change the engine voice)');
}
