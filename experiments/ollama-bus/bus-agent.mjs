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
const consumed = new Set(['--type', '--tail', '--prio', '--rounds', '--interval', '--max-posts']);
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

const watch = argv.includes('--watch');
const OWNER = process.env.VIHS_COLLAB_OWNER || 'LabVIEW-Community-CI-CD';
const REPO = busEnv.VIHS_COLLAB_REPO;
const GH = process.env.GH_BIN || 'gh';

// READ the bus via collab-cli (the peer plane's ollama posts) -- the single-shot read.
function readPeerRecent() {
  try {
    return lbabus(['poll', '--full', '--agent', PEER, '--tail', String(tail)]);
  } catch (err) {
    return `(bus read failed: ${err.message})`;
  }
}

// Fresh read of the peer's LATEST message (watch-mode change detection needs freshness the poll cache lacks).
function readPeerLatestFresh() {
  const q = `{repository(owner:"${OWNER}",name:"${REPO}"){discussion(number:1){comments(last:10){nodes{createdAt bodyText}}}}}`;
  const jq = `[.data.repository.discussion.comments.nodes[]|select(.bodyText|test("\\\\[${PEER}\\\\]"))]|last`;
  try {
    const out = execFileSync(GH, ['api', 'graphql', '-f', `query=${q}`, '--jq', jq], { env: busEnv, encoding: 'utf8', maxBuffer: 1 << 20 });
    const node = JSON.parse(out || 'null');
    return node ? { fingerprint: node.createdAt, text: node.bodyText } : null;
  } catch {
    return null;
  }
}

// GENERATE via the ollama ENGINE (lba-coordinator: lesson-store-governed, bus-aware).
async function generate(recent) {
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
  return String(j.response || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\x60"'$!]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 900);
}

function postMsg(msg) {
  const out = lbabus(['post', '--type', type, '--to', PEER, '--priority', prio, '--message', msg]);
  return (out.trim().split('\n').pop() || '').trim();
}

if (!watch) {
  // Single-shot: read -> engine drafts -> print (dry-run) or post.
  const msg = await generate(readPeerRecent());
  if (!msg) {
    console.error('engine produced no message');
    process.exit(1);
  }
  console.log(`[${AGENT} bus-agent] engine(${MODEL}) generated a ${type}/${prio} to ${PEER}:`);
  console.log(msg);
  if (doPost) {
    console.log(`\nposted -> ${postMsg(msg)}`);
  } else {
    console.log('\n(dry-run -- add --post to send; iterate the lba-coordinator model to change the engine voice)');
  }
} else {
  // WATCH: the constantly-iterated engine loop. Baseline the peer's latest, then respond to genuinely NEW peer
  // messages -- draft-only by default (the big agent reviews), or autopost with a hard cap when --post is set.
  const interval = Number(flag('--interval', '30')) * 1000;
  const maxRounds = Number(flag('--rounds', '0'));
  const maxPosts = Number(flag('--max-posts', '3'));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let lastFp = null;
  let round = 0;
  let posts = 0;
  console.log(`[${AGENT} watch] engine monitoring ${PEER} every ${interval / 1000}s (${doPost ? `AUTOPOST cap ${maxPosts}` : 'draft-only'}); intent: ${intent}`);
  for (;;) {
    round += 1;
    const latest = readPeerLatestFresh();
    if (latest && lastFp === null) {
      lastFp = latest.fingerprint;
      console.log(`[watch r${round}] baseline ${PEER} @ ${lastFp} (will respond to newer)`);
    } else if (latest && latest.fingerprint !== lastFp) {
      lastFp = latest.fingerprint;
      const msg = await generate(latest.text);
      console.log(`\n[watch r${round}] NEW ${PEER} @ ${latest.fingerprint} -> engine draft:\n  ${msg}`);
      if (doPost && msg && posts < maxPosts) {
        console.log(`  posted -> ${postMsg(msg)}`);
        posts += 1;
      }
    } else {
      console.log(`[watch r${round}] no new ${PEER} message (last ${lastFp || 'none'})`);
    }
    if (maxRounds && round >= maxRounds) {
      break;
    }
    if (doPost && posts >= maxPosts) {
      console.log('[watch] max-posts reached; stopping.');
      break;
    }
    await sleep(interval);
  }
}
