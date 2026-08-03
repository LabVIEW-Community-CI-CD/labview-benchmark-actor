#!/usr/bin/env node
// build-agent-request.mjs -- emit a validated agent-request@1 beacon JSON on stdout (LBA-REQ-056, ADR-0036).
//
// Used by request-step.sh to build the Handoff Beacon agent->human request from the SAME pure, gated builder the
// extension + the handoff-request gate use, so the JSON the agent drops into the VM is always schema-correct and
// its text is safely escaped (JSON.stringify). Usage:
//   node reviewer-workstation/build-agent-request.mjs --id req-123 --title "Run the VI, then Stop" [--body "..."] [--kind step|ack]

import { buildAgentRequest, validateAgentRequest } from '../experiments/handoff-beacon/handoffRequest.mjs';

const arg = (k, d = '') => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : d;
};

const req = buildAgentRequest({
  id: arg('id'),
  title: arg('title'),
  body: arg('body'),
  kind: arg('kind', 'step'),
  createdAt: new Date().toISOString(),
});

const v = validateAgentRequest(req);
if (!v.ok) {
  console.error(`build-agent-request: invalid request -- ${v.errors.join('; ')}`);
  process.exit(4);
}
process.stdout.write(`${JSON.stringify(req, null, 2)}\n`);
