// reviewerVerdict.mjs -- the reviewer VISUAL VERDICT beacon (LBA-REQ-057, ADR-0037): the verdict tier of the
// Handoff Beacon Protocol (ADR-0035, ADR-0037).
//
// The reviewer VM exists for ONE thing above all: the human's VISUAL PASS/FAIL of an extension release
// CANDIDATE (does the built .vsix look + work right?). PR1-3 made the capture/correlator/handoff steps
// machine-observable; this makes the VERDICT itself a governed, signed artifact. The human renders a verdict on
// a specific candidate (component + version + commit + .vsix sha256) with evidence pointers (the capture runs /
// peak frames), and SIGNS it in the VM with an ENROLLED Ed25519 reviewer key (reusing the ADR-0016 primitives
// from acg-provenance/attest.mjs -- no OIDC needed, so it works headless in the VM). The signed verdict maps to
// an `acg-human-signoff-v1` (the existing human-signoff schema) so it feeds `gateVisualReview` + the release
// gate; CI keyless-cosign counter-signs the verdict bundle for a transparency-logged record.
//
// PURE + deterministic (Node crypto only). Fails closed everywhere.

import crypto from 'node:crypto';

export const REVIEWER_VERDICT_SCHEMA = 'labview-benchmark-actor/reviewer-verdict@1';
export const SIGNOFF_SCHEMA = 'labview-benchmark-actor/acg-human-signoff-v1'; // the verdict maps to this
export const VERDICTS = Object.freeze(['pass', 'fail', 'changes']);
export const REVIEWER_STATIONS = Object.freeze(['WINDOWS_VM', 'LINUX_CODESPACE']);

// Deterministic canonical JSON (recursively sorted keys) so a verdict's digest is stable regardless of key
// order. INLINED (dependency-free, Node crypto only) so this module stages into the extension's media/ and
// SIGNS in the reviewer VM -- it mirrors acg-provenance/attest.mjs's canonicalize/bundleDigest byte-for-byte.
export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}
export const bundleDigest = (bundle) => crypto.createHash('sha256').update(canonicalize(bundle)).digest('hex');

/** Mint an Ed25519 keypair for a reviewer identity (the private key stays with the reviewer; the public key is
 *  enrolled in the allowlist). Same shape as attest.mjs's enrollment. */
export function generateEnrolledKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

const str = (v, dflt = null) => (v != null ? String(v) : dflt);
const normPem = (p) => String(p || '').replace(/\s+/g, '');
// The bytes a reviewer signs: reviewer + decision + station bound to the digest of the exact verdict.
const signMessage = (reviewer, decision, station, digest) => Buffer.from(`${reviewer}\n${decision}\n${station}\n${digest}`, 'utf8');

/** Build the rich reviewer verdict beacon: the human's PASS/FAIL of a specific release candidate + evidence. */
export function buildReviewerVerdict(opts = {}) {
  const t = opts.target && typeof opts.target === 'object' ? opts.target : {};
  const verdict = VERDICTS.includes(opts.verdict) ? opts.verdict : 'fail';
  const station = REVIEWER_STATIONS.includes(opts.station) ? opts.station : 'WINDOWS_VM';
  return {
    schema: REVIEWER_VERDICT_SCHEMA,
    target: {
      component: str(t.component, 'extension'),
      version: str(t.version),
      commit: str(t.commit),
      vsixSha256: str(t.vsixSha256),
    },
    verdict,
    reviewer: str(opts.reviewer),
    station,
    notes: str(opts.notes, ''),
    evidence: Array.isArray(opts.evidence)
      ? opts.evidence.filter((e) => e && e.ref != null).map((e) => ({ kind: str(e.kind, 'note'), ref: str(e.ref) }))
      : [],
    renderedAt: str(opts.renderedAt),
  };
}

/** Fail-closed shape check for a reviewer verdict before it is signed / consumed. */
export function validateReviewerVerdict(v) {
  const errors = [];
  const r = v && typeof v === 'object' ? v : {};
  if (r.schema !== REVIEWER_VERDICT_SCHEMA) errors.push(`schema must be ${REVIEWER_VERDICT_SCHEMA}`);
  if (!VERDICTS.includes(r.verdict)) errors.push(`verdict must be one of ${VERDICTS.join('|')}`);
  if (!r.target || typeof r.target !== 'object') errors.push('verdict needs a target object');
  else {
    if (!r.target.version) errors.push('target needs a version');
    if (!r.target.commit) errors.push('target needs a commit');
  }
  if (!r.reviewer) errors.push('verdict needs a reviewer');
  if (!REVIEWER_STATIONS.includes(r.station)) errors.push(`station must be one of ${REVIEWER_STATIONS.join('|')}`);
  return { ok: errors.length === 0, errors };
}

/** The digest a reviewer signs: the canonical verdict, so a signature cannot be moved to a different verdict. */
export const reviewerVerdictDigest = (v) => bundleDigest(v);

/**
 * Sign a reviewer verdict -> an `acg-human-signoff-v1` bound to the verdict digest (Ed25519, enrolled reviewer).
 * A 'pass' verdict is an 'approve' decision; anything else is 'reject'. Mirrors acg-reviewer/sign-off.mjs so the
 * output is a first-class human sign-off.
 */
export function signReviewerVerdict(verdict, { privateKeyPem, reviewer, station = 'WINDOWS_VM' } = {}) {
  if (!privateKeyPem) throw new Error('signReviewerVerdict: privateKeyPem is required');
  if (!reviewer) throw new Error('signReviewerVerdict: reviewer is required');
  if (!REVIEWER_STATIONS.includes(station)) throw new Error(`signReviewerVerdict: station must be one of ${REVIEWER_STATIONS.join('|')}`);
  const decision = verdict?.verdict === 'pass' ? 'approve' : 'reject';
  const priv = crypto.createPrivateKey(privateKeyPem);
  const publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  const verdictDigest = reviewerVerdictDigest(verdict);
  const signature = crypto.sign(null, signMessage(reviewer, decision, station, verdictDigest), priv).toString('base64');
  return {
    schema: SIGNOFF_SCHEMA,
    subject: { verdictDigest, consensusVerdict: verdict?.verdict ?? null, target: verdict?.target ?? null },
    reviewer,
    decision,
    station,
    algorithm: 'ed25519',
    publicKeyPem,
    signedAt: new Date().toISOString(),
    signature,
  };
}

/**
 * Verify ONE reviewer sign-off over a verdict against the enrolled reviewer allowlist (reviewer -> publicKeyPem).
 * Fails closed on a wrong schema/algorithm/station, a digest that does not match the verdict, an un-enrolled
 * reviewer, a key that does not match the enrolled one, or a signature that does not verify.
 */
export function verifyReviewerVerdict(verdict, signOff, { reviewerAllowlist = {} } = {}) {
  const reasons = [];
  if (!signOff || signOff.schema !== SIGNOFF_SCHEMA) return { ok: false, reasons: ['not an acg-human-signoff-v1'] };
  if (signOff.algorithm !== 'ed25519') reasons.push(`unsupported algorithm ${signOff.algorithm}`);
  if (!REVIEWER_STATIONS.includes(signOff.station)) reasons.push(`unknown reviewer station ${signOff.station}`);
  const actualDigest = reviewerVerdictDigest(verdict);
  if (signOff.subject?.verdictDigest !== actualDigest) reasons.push('sign-off does not match this verdict');
  const enrolledKey = reviewerAllowlist[signOff.reviewer];
  if (!enrolledKey) reasons.push(`reviewer "${signOff.reviewer}" is not enrolled`);
  else if (normPem(enrolledKey) !== normPem(signOff.publicKeyPem)) reasons.push(`presented key does not match the enrolled key for "${signOff.reviewer}"`);
  try {
    const ok = crypto.verify(null, signMessage(signOff.reviewer, signOff.decision, signOff.station, actualDigest), crypto.createPublicKey(signOff.publicKeyPem), Buffer.from(signOff.signature || '', 'base64'));
    if (!ok) reasons.push('sign-off signature does not verify');
  } catch (e) {
    reasons.push('signature verification error: ' + e.message);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * THE LBA-REQ-057 GATE: a candidate passes VISUAL review only when its reviewer verdict is 'pass' AND
 * >= minReviewers DISTINCT enrolled reviewers have a verified 'approve' sign-off over exactly this verdict.
 * Structurally mirrors gateReleasePublish (ADR-0018) but for the human VISUAL verdict of a release candidate.
 */
export function gateVisualReview({ verdict, signOffs = [], reviewerAllowlist = {}, minReviewers = 1 } = {}) {
  const reasons = [];
  const verdictPass = verdict?.verdict === 'pass';
  if (!verdictPass) reasons.push(`reviewer verdict is ${verdict?.verdict ?? 'missing'}, not pass`);
  const approvals = [];
  for (const s of signOffs) {
    const v = verifyReviewerVerdict(verdict, s, { reviewerAllowlist });
    if (!v.ok) { reasons.push(`sign-off by "${s?.reviewer ?? '?'}": ${v.reasons.join('; ')}`); continue; }
    if (s.decision !== 'approve') { reasons.push(`reviewer "${s.reviewer}" decision is "${s.decision}", not approve`); continue; }
    approvals.push(s.reviewer);
  }
  const distinct = [...new Set(approvals)];
  if (distinct.length < minReviewers) reasons.push(`need >= ${minReviewers} distinct enrolled approving reviewer(s); have ${distinct.length}`);
  return {
    schema: 'labview-benchmark-actor/acg-visual-review-decision-v1',
    publish: verdictPass && distinct.length >= minReviewers,
    verdictPass,
    approvals: distinct,
    minReviewers,
    reasons,
  };
}
