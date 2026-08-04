#!/usr/bin/env node
// sign-visual-verdict.mjs -- a DETERMINISTIC, offline reviewer VISUAL verdict sign-off (LBA-REQ-057, ADR-0037),
// replacing the net-drive ceremony (which times out). The reviewer runs this LOCALLY with their enrolled Ed25519
// PRIVATE key (kept local, NEVER committed) AFTER visually reviewing the built candidate: it reads a staged
// verdict REQUEST (the fixed candidate target + evidence the reviewer is attesting), builds the reviewer-verdict@1,
// signs it, and writes the signed record `{ verdict, signOff }` -- which carries only PUBLIC material and is safe
// to commit. No network, no VM, no timeout.
//
// The signed bytes are exactly `${reviewer}\n${decision}\n${station}\n${bundleDigest(verdict)}` (reviewerVerdict.mjs),
// so the sign-off is verifiable by anyone against the verdict + the enrolled allowlist.
//
// Usage:
//   node reviewer-workstation/sign-visual-verdict.mjs --key <privkey.pem> --request <request.json> [--out <record.json>]
//
// The request.json fixes the candidate the reviewer signs (staged by the maintainer): it is the FULL verdict input
//   { target:{component,version,commit,vsixSha256}, verdict:"pass", reviewer, station, notes, evidence:[{kind,ref}] }

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReviewerVerdict, signReviewerVerdict, validateReviewerVerdict, reviewerVerdictDigest } from '../experiments/handoff-beacon/reviewerVerdict.mjs';

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  if (!opt.key || !opt.request) {
    console.error('usage: sign-visual-verdict.mjs --key <privkey.pem> --request <request.json> [--out <record.json>]');
    process.exit(2);
  }
  const req = JSON.parse(readFileSync(opt.request, 'utf8'));
  const privateKeyPem = readFileSync(opt.key, 'utf8');
  const verdict = buildReviewerVerdict({
    target: req.target,
    verdict: req.verdict ?? 'pass',
    reviewer: req.reviewer,
    station: req.station ?? 'WINDOWS_VM',
    notes: req.notes ?? '',
    evidence: req.evidence ?? [],
    renderedAt: req.renderedAt ?? new Date().toISOString(),
  });
  const shape = validateReviewerVerdict(verdict);
  if (!shape.ok) { console.error('invalid verdict: ' + shape.errors.join('; ')); process.exit(1); }
  const signOff = signReviewerVerdict(verdict, { privateKeyPem, reviewer: req.reviewer, station: verdict.station });
  const record = { verdict, signOff };
  console.error(`signed VISUAL verdict ${verdict.verdict.toUpperCase()} for ${verdict.target.component} ${verdict.target.version} @ ${String(verdict.target.commit).slice(0, 9)} / vsix ${String(verdict.target.vsixSha256).slice(0, 12)} as ${req.reviewer} @ ${verdict.station} (verdictDigest ${reviewerVerdictDigest(verdict)})`);
  const json = JSON.stringify(record, null, 2);
  if (typeof opt.out === 'string') {
    writeFileSync(opt.out, json + '\n');
    console.error(`wrote ${opt.out} -- send this (it is PUBLIC; your private key stays local).`);
  } else {
    process.stdout.write(json + '\n');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
