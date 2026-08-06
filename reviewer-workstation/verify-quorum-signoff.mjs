#!/usr/bin/env node
// verify-quorum-signoff.mjs -- host-side verifier for a VM-produced machine quorum sign-off (#415, LBA-REQ-089 /
// ADR-0071 / ADR-0018). render-quorum.sh's `verify` leg (and the release flow) use this to confirm the collected
// acg-human-signoff-v1 genuinely signs THIS attestation's quorum bundleDigest with an ENROLLED reviewer key --
// BEFORE the sign-off is folded into the composite receipt. Fail-closed.
//
// Pure + offline + dependency-free: reuses the ADR-0018 verifyReleaseSignOff primitive + the attestation-or-quorum
// unwrap (quorumFromDoc). The private key never appears here -- only the PUBLIC sign-off is verified. It also
// re-asserts the ADR-0071 property that the ATTESTED quorum is itself genuine (passing + cross-plane): a verified
// signature over a single-plane / non-pass quorum is exactly the shipped 1.0.0 defect this repo re-sealed.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { quorumFromDoc } from './sign-release-quorum.mjs';
import { verifyReleaseSignOff } from '../experiments/acg-reviewer/sign-off.mjs';

// Verify a collected sign-off against the attestation's quorum + the enrolled reviewer allowlist. Returns
// { ok, reasons, reviewer, station, crossPlane, verdict } -- ok only when the signature verifies against an
// enrolled key over THIS quorum AND the quorum is a genuine passing cross-plane consensus.
export function verifyQuorumSignOff({ attestationDoc, signOff, reviewerAllowlist = {} }) {
  const quorum = quorumFromDoc(attestationDoc);
  const base = verifyReleaseSignOff(quorum, signOff, { reviewerAllowlist });
  const reasons = [...base.reasons];
  if (quorum?.verdict !== 'pass') reasons.push(`attested quorum verdict is ${quorum?.verdict ?? 'missing'}, not pass`);
  if (quorum?.crossPlane !== true) reasons.push('attested quorum is not cross-plane (a single-plane quorum is the shipped 1.0.0 defect)');
  return {
    ok: reasons.length === 0,
    reasons,
    reviewer: signOff?.reviewer ?? null,
    station: signOff?.station ?? null,
    crossPlane: quorum?.crossPlane === true,
    verdict: quorum?.verdict ?? null,
  };
}

// Read a reviewer allowlist (reviewer id -> Ed25519 SPKI public-key PEM), dropping the _comment + non-string keys.
function readAllowlist(path) {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const out = {};
    for (const [k, v] of Object.entries(raw)) if (k !== '_comment' && typeof v === 'string') out[k] = v;
    return out;
  } catch { return {}; }
}

function main() {
  const argv = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < argv.length; i += 1) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  if (!opt.attestation || !opt.signoff) {
    console.error('usage: verify-quorum-signoff.mjs --attestation <attestation-or-quorum.json> --signoff <quorum-signoff.json> [--allowlist <reviewer-allowlist.json>]');
    process.exit(2);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const allowlistPath = typeof opt.allowlist === 'string' ? opt.allowlist : join(here, '..', 'tools', 'collab-cli', 'reviewer-allowlist.json');
  const attestationDoc = JSON.parse(readFileSync(opt.attestation, 'utf8'));
  const signOff = JSON.parse(readFileSync(opt.signoff, 'utf8'));
  const r = verifyQuorumSignOff({ attestationDoc, signOff, reviewerAllowlist: readAllowlist(allowlistPath) });
  if (!r.ok) {
    console.error(`[verify-quorum-signoff] FAIL: ${r.reasons.join('; ')}`);
    process.exit(1);
  }
  console.log(`[verify-quorum-signoff] OK: ${r.reviewer} @ ${r.station} signed the crossPlane quorum (verdict=${r.verdict})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
