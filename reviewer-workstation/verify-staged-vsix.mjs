#!/usr/bin/env node
// verify-staged-vsix.mjs -- the staged-candidate SHA GUARD for the reviewer visual verdict (#411, LBA-REQ-057 /
// ADR-0037). The human PASS is only meaningful if the reviewer inspected the EXACT build that ships: if the .vsix
// staged in the VM (C:\lba-review\candidate.vsix) is not byte-identical to the candidate the verdict binds to
// (target.vsixSha256), the reviewer is reviewing a DIFFERENT build than ships -- the reviewed==shipped defect that
// bit 1.1.0 (a node-22 local review vs the node-24 published bytes). render-verdict.sh's `guard` leg computes the
// staged .vsix sha256 IN the VM and calls this to fail closed BEFORE a verdict is set/collected.
//
// Pure + offline: `stagedVsixMatches` is a deterministic case-insensitive 64-hex comparison with fail-closed
// validation; the VM sha computation is the shell wrapper's live leg. The candidate sha may be passed directly
// or read from a verdict request/record (target.vsixSha256).

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Compare a staged .vsix sha256 against the candidate sha256. Returns { ok, reasons, candidateSha256, stagedSha256 }.
// Fails closed when either value is not a 64-hex digest, or when they differ (reviewing a different build than ships).
export function stagedVsixMatches({ candidateSha256, stagedSha256 } = {}) {
  const norm = (s) => String(s ?? '').trim().toLowerCase();
  const c = norm(candidateSha256);
  const s = norm(stagedSha256);
  const reasons = [];
  if (!/^[0-9a-f]{64}$/.test(c)) reasons.push(`candidate sha256 is not a 64-hex digest: "${candidateSha256}"`);
  if (!/^[0-9a-f]{64}$/.test(s)) reasons.push(`staged .vsix sha256 is not a 64-hex digest: "${stagedSha256}"`);
  if (reasons.length === 0 && c !== s) {
    reasons.push(`staged .vsix sha256 ${s.slice(0, 12)}… != candidate ${c.slice(0, 12)}… — the VM has a DIFFERENT build than the candidate (reviewed!=shipped); re-stage the exact candidate before reviewing`);
  }
  return { ok: reasons.length === 0, reasons, candidateSha256: c, stagedSha256: s };
}

// Resolve the candidate sha256 from an explicit value or a verdict request/record ({ target:{vsixSha256} } or
// { verdict:{ target:{vsixSha256} } }).
export function candidateShaFrom({ candidateSha256, requestDoc } = {}) {
  if (candidateSha256) return String(candidateSha256);
  const target = requestDoc?.target ?? requestDoc?.verdict?.target ?? null;
  return target?.vsixSha256 ? String(target.vsixSha256) : '';
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  if (!opt['staged-sha256'] || (!opt['candidate-sha256'] && !opt.request)) {
    console.error('usage: verify-staged-vsix.mjs --staged-sha256 <sha> (--candidate-sha256 <sha> | --request <request.json>)');
    process.exit(2);
  }
  const requestDoc = typeof opt.request === 'string' ? JSON.parse(readFileSync(opt.request, 'utf8')) : null;
  const candidateSha256 = candidateShaFrom({ candidateSha256: opt['candidate-sha256'], requestDoc });
  const r = stagedVsixMatches({ candidateSha256, stagedSha256: opt['staged-sha256'] });
  if (!r.ok) {
    console.error(`[verify-staged-vsix] FAIL: ${r.reasons.join('; ')}`);
    process.exit(1);
  }
  console.log(`[verify-staged-vsix] OK: staged .vsix matches the candidate (sha256 ${r.candidateSha256.slice(0, 12)}…)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
