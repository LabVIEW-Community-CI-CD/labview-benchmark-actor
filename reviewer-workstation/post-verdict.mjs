#!/usr/bin/env node
// post-verdict.mjs -- announce a signed reviewer verdict on the lbabus coordination bus (LBA-REQ-058, ADR-0038).
//
// Reads a collected verdict record { verdict, signOff }, builds the SEMANTIC lbabus post via the same gated
// builder the extension uses (buildVerdictBusPost: PASS->RESOLVED / CHANGES->REFINE / FAIL->BLOCKED), and posts
// it with `lbabus post ... --message-file <verdict>` so the FULL signed verdict JSON is the message body. Used by
// the release CI (auto, after verify-visual-review) + runnable by hand. The extension also posts from the VM.
//
// Usage:
//   node reviewer-workstation/post-verdict.mjs --verdict <record.json> [--bus <lbabus>]   # post
//   node reviewer-workstation/post-verdict.mjs --verdict <record.json> --print-args         # print the argv only
//   node reviewer-workstation/post-verdict.mjs --verdict <record.json> --dry-run            # print the full command
// Auth: lbabus needs GH_TOKEN / GITHUB_TOKEN (or `gh auth token`).

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildVerdictBusPost } from '../experiments/handoff-beacon/reviewerVerdict.mjs';

const arg = (k, d = '') => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const verdictPath = arg('verdict');
if (!verdictPath) {
  console.error('usage: post-verdict.mjs --verdict <record.json> [--bus <lbabus>] [--print-args] [--dry-run]');
  process.exit(2);
}

const record = JSON.parse(readFileSync(verdictPath, 'utf8'));
const post = buildVerdictBusPost(record);
const args = ['post', '--type', post.type, '--task', post.task, '--priority', post.priority, '--message-file', verdictPath];
if (post.ref) args.push('--ref', post.ref);

// --print-args: emit just the `post ...` argv (so a caller can run e.g. `dotnet run --project ... -- <argv>`).
if (has('print-args')) {
  process.stdout.write(`${args.join(' ')}\n`);
  process.exit(0);
}

const bus = arg('bus', 'lbabus');
console.error(`[post-verdict] ${post.summary}`);
if (has('dry-run')) {
  process.stdout.write(`${bus} ${args.join(' ')}\n`);
  process.exit(0);
}

const r = spawnSync(bus, args, { stdio: 'inherit', env: process.env });
if (r.error) {
  console.error(`[post-verdict] bus post skipped (${bus} unavailable?): ${r.error.message}`);
  process.exit(3);
}
process.exit(r.status ?? 1);
