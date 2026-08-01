#!/usr/bin/env node
// sign-off.mjs -- ACG reviewer station + human sign-off gate (ADR-0018, LBA-REQ-027).
//
// The recorded, signed human sign-off is a SEPARATE gate layered ON TOP of the machine quorum (ADR-0015): a
// corroborated release publishes ONLY when the machine quorum passes AND a recorded human sign-off accompanies
// that exact verdict -- the sign-off never substitutes for the quorum. A reviewer signs from EITHER station (the
// Windows reviewer VM or a zero-install Linux browser codespace -- reviewer's choice), recorded in the sign-off.
// Architected for a multi-reviewer human quorum (minReviewers), single reviewer today. Reuses the ADR-0016 Ed25519
// primitives (an enrolled reviewer keypair signs the quorum-verdict digest). Dependency-free.

import crypto from 'node:crypto';
import { bundleDigest, generateEnrolledKeypair } from '../acg-provenance/attest.mjs';

export const REVIEWER_STATIONS = ['WINDOWS_VM', 'LINUX_CODESPACE'];
const SIGNOFF_SCHEMA = 'labview-benchmark-actor/acg-human-signoff-v1';
const normPem = (p) => String(p || '').replace(/\s+/g, '');
// The bytes a reviewer signs: reviewer + decision + station bound to the digest of the exact quorum verdict.
const signOffMessage = (reviewer, decision, station, verdictDigest) => Buffer.from(`${reviewer}\n${decision}\n${station}\n${verdictDigest}`, 'utf8');

// Re-export the enrollment helper so a reviewer keypair can be minted the same way witnesses are enrolled.
export { generateEnrolledKeypair };

// A reviewer records a signed human sign-off over a machine quorum verdict.
export function signReleaseSignOff(quorumVerdict, { privateKeyPem, reviewer, decision = 'approve', station } = {}) {
  if (!privateKeyPem) throw new Error('signReleaseSignOff: privateKeyPem is required');
  if (!reviewer) throw new Error('signReleaseSignOff: reviewer is required');
  if (!REVIEWER_STATIONS.includes(station)) throw new Error(`signReleaseSignOff: station must be one of ${REVIEWER_STATIONS.join('|')}`);
  const priv = crypto.createPrivateKey(privateKeyPem);
  const publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  const verdictDigest = bundleDigest(quorumVerdict);
  const signature = crypto.sign(null, signOffMessage(reviewer, decision, station, verdictDigest), priv).toString('base64');
  return {
    schema: SIGNOFF_SCHEMA,
    subject: { verdictDigest, consensusVerdict: quorumVerdict?.verdict ?? null },
    reviewer,
    decision,
    station,
    algorithm: 'ed25519',
    publicKeyPem,
    signedAt: new Date().toISOString(),
    signature,
  };
}

// Verify ONE sign-off against the quorum verdict + the enrolled reviewer allowlist (reviewer -> publicKeyPem).
// Fails closed on a wrong schema/algorithm/station, a digest that does not match the verdict, an un-enrolled
// reviewer, a key that does not match the enrolled one, or a signature that does not verify.
export function verifyReleaseSignOff(quorumVerdict, signOff, { reviewerAllowlist = {} } = {}) {
  const reasons = [];
  if (!signOff || signOff.schema !== SIGNOFF_SCHEMA) return { ok: false, reasons: ['not an acg-human-signoff-v1'] };
  if (signOff.algorithm !== 'ed25519') reasons.push(`unsupported algorithm ${signOff.algorithm}`);
  if (!REVIEWER_STATIONS.includes(signOff.station)) reasons.push(`unknown reviewer station ${signOff.station}`);
  const actualDigest = bundleDigest(quorumVerdict);
  if (signOff.subject?.verdictDigest !== actualDigest) reasons.push('sign-off does not match this quorum verdict');
  const enrolledKey = reviewerAllowlist[signOff.reviewer];
  if (!enrolledKey) reasons.push(`reviewer "${signOff.reviewer}" is not enrolled`);
  else if (normPem(enrolledKey) !== normPem(signOff.publicKeyPem)) reasons.push(`presented key does not match the enrolled key for "${signOff.reviewer}"`);
  try {
    const ok = crypto.verify(null, signOffMessage(signOff.reviewer, signOff.decision, signOff.station, actualDigest), crypto.createPublicKey(signOff.publicKeyPem), Buffer.from(signOff.signature || '', 'base64'));
    if (!ok) reasons.push('sign-off signature does not verify');
  } catch (e) {
    reasons.push('signature verification error: ' + e.message);
  }
  return { ok: reasons.length === 0, reasons };
}

// THE LBA-REQ-027 GATE: a corroborated release publishes ONLY when the machine quorum passes AND at least
// `minReviewers` DISTINCT enrolled reviewers have a verified `approve` sign-off over exactly this verdict. The
// sign-off does not substitute for the quorum (both are independently required). Returns { publish, reasons }.
export function gateReleasePublish({ quorumVerdict, signOffs = [], reviewerAllowlist = {}, minReviewers = 1 } = {}) {
  const reasons = [];
  const quorumPass = quorumVerdict?.verdict === 'pass';
  if (!quorumPass) reasons.push(`machine quorum verdict is ${quorumVerdict?.verdict ?? 'missing'}, not pass`);
  const approvals = [];
  for (const s of signOffs) {
    const v = verifyReleaseSignOff(quorumVerdict, s, { reviewerAllowlist });
    if (!v.ok) { reasons.push(`sign-off by "${s?.reviewer ?? '?'}": ${v.reasons.join('; ')}`); continue; }
    if (s.decision !== 'approve') { reasons.push(`reviewer "${s.reviewer}" decision is "${s.decision}", not approve`); continue; }
    approvals.push(s.reviewer);
  }
  const distinctApprovers = [...new Set(approvals)];
  if (distinctApprovers.length < minReviewers) {
    reasons.push(`need >= ${minReviewers} distinct enrolled approving reviewer(s); have ${distinctApprovers.length}`);
  }
  return {
    schema: 'labview-benchmark-actor/acg-release-decision-v1',
    publish: quorumPass && distinctApprovers.length >= minReviewers,
    quorumPass,
    approvals: distinctApprovers,
    minReviewers,
    reasons,
  };
}

// CLI: sign-off.mjs decide --verdict <quorum.json> [--signoff <s.json>]... [--allowlist <f>] [--min <n>]  -> the release decision.
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const opt = {};
  const signoffPaths = [];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--signoff') signoffPaths.push(argv[(i += 1)]);
    else if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  const { readFileSync } = await import('node:fs');
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  if (argv[0] !== 'decide' || !opt.verdict) {
    console.error('usage: sign-off.mjs decide --verdict <quorum.json> [--signoff <s.json>]... [--allowlist <f>] [--min <n>]');
    process.exit(2);
  }
  const decision = gateReleasePublish({
    quorumVerdict: readJson(opt.verdict),
    signOffs: signoffPaths.map(readJson),
    reviewerAllowlist: opt.allowlist ? readJson(opt.allowlist) : {},
    minReviewers: opt.min ? Number(opt.min) : 1,
  });
  console.log(JSON.stringify(decision, null, 2));
  process.exit(decision.publish ? 0 : 1);
}
