#!/usr/bin/env node
// attest.mjs -- Actor Corroboration Grid provenance + attestation engine (ADR-0016, LBA-REQ-025).
//
// The enforceable core of "verify before consume": each witness SIGNS its receipt bundle with an identity it can
// actually hold (this slice: an ENROLLED per-witness Ed25519 keypair -- the VBOX/WIN path; the sigstore-keyless
// OIDC path for codespace/Actions layers on top later), and a release is NOT consumable until the whole chain
// verifies -- every witness attestation checks out against the enrolled allowlist, the witnesses are DISTINCT
// enrolled identities (no N-of-a-kind, ADR-0017), AND the quorum RE-COMPUTED over the attested bundles passes.
//
// Dependency-free (Node builtins only: node:crypto Ed25519). The quorum is re-derived here so a valid verdict can
// never be paired with a different (tampered) set of bundles. Attestation schema: acg-witness-attestation-v1.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { compareWitnesses } from '../acg-quorum/compare-witnesses.mjs';

const ATTESTATION_SCHEMA = 'labview-benchmark-actor/acg-witness-attestation-v1';

// Deterministic canonical JSON (recursively sorted keys) so a bundle's digest is stable regardless of key order.
export function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value ?? null);
}
export const bundleDigest = (bundle) => crypto.createHash('sha256').update(canonicalize(bundle)).digest('hex');

// The bytes a witness signs: its identity bound to the digest of exactly the bundle it produced.
const signedMessage = (identity, digest) => Buffer.from(`${identity}\n${digest}`, 'utf8');
const normPem = (pem) => String(pem || '').replace(/\s+/g, '');

// Enrollment helper: mint an Ed25519 keypair for a witness identity. The PRIVATE key stays with the witness
// (never in the repo); the PUBLIC key is enrolled in the allowlist.
export function generateEnrolledKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
  };
}

// A witness signs its bundle -> an attestation binding {digest of the bundle, witness identity} under its key.
export function signBundle(bundle, { privateKeyPem, identity }) {
  if (!bundle || typeof bundle !== 'object') throw new Error('signBundle: a bundle object is required');
  if (!privateKeyPem) throw new Error('signBundle: privateKeyPem is required');
  if (!identity) throw new Error('signBundle: identity is required');
  const priv = crypto.createPrivateKey(privateKeyPem);
  const publicKeyPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' });
  const digest = bundleDigest(bundle);
  const signature = crypto.sign(null, signedMessage(identity, digest), priv).toString('base64');
  return {
    schema: ATTESTATION_SCHEMA,
    subject: {
      digest,
      plane: bundle.plane ?? null,
      os: bundle.os ?? null,
      sourceCommit: bundle?.gate?.lbabus?.sourceCommit ?? null,
    },
    witnessIdentity: identity,
    algorithm: 'ed25519',
    publicKeyPem,
    signature,
    signedAt: new Date().toISOString(),
  };
}

// Verify ONE witness attestation against the bundle + the enrolled allowlist (identity -> enrolled publicKeyPem).
// Fails closed: wrong schema/algorithm, a digest that does not match the bundle, an un-enrolled identity, a key
// that does not match the enrolled one, or a signature that does not verify.
export function verifyWitnessAttestation(bundle, attestation, { allowlist = {} } = {}) {
  const reasons = [];
  if (!attestation || attestation.schema !== ATTESTATION_SCHEMA) {
    return { ok: false, reasons: ['not an acg-witness-attestation-v1'] };
  }
  if (attestation.algorithm !== 'ed25519') reasons.push(`unsupported algorithm ${attestation.algorithm}`);
  const actualDigest = bundleDigest(bundle);
  if (attestation.subject?.digest !== actualDigest) {
    reasons.push(`subject digest does not match the bundle (attested ${attestation.subject?.digest ?? 'none'}, actual ${actualDigest})`);
  }
  const enrolledKey = allowlist[attestation.witnessIdentity];
  if (!enrolledKey) reasons.push(`witness identity "${attestation.witnessIdentity}" is not enrolled`);
  else if (normPem(enrolledKey) !== normPem(attestation.publicKeyPem)) {
    reasons.push(`presented key does not match the enrolled key for "${attestation.witnessIdentity}"`);
  }
  try {
    const ok = crypto.verify(null, signedMessage(attestation.witnessIdentity, actualDigest), crypto.createPublicKey(attestation.publicKeyPem), Buffer.from(attestation.signature || '', 'base64'));
    if (!ok) reasons.push('signature does not verify');
  } catch (e) {
    reasons.push('signature verification error: ' + e.message);
  }
  return { ok: reasons.length === 0, reasons };
}

// VERIFY BEFORE CONSUME (the LBA-REQ-025 gate): a release is consumable ONLY when every witness attestation
// verifies against the enrolled allowlist, the witnesses are DISTINCT enrolled identities (ADR-0017), and the
// quorum RE-COMPUTED over exactly the attested bundles passes. Returns { consume, reasons, verdict }.
export function verifyBeforeConsume({ witnesses, allowlist = {}, quorumMin = 2, threshold = 0.5 } = {}) {
  const reasons = [];
  if (!Array.isArray(witnesses) || witnesses.length < quorumMin) {
    return { consume: false, reasons: [`need at least ${quorumMin} attested witnesses`], verdict: null };
  }
  const perWitness = witnesses.map(({ bundle, attestation }) => ({
    identity: attestation?.witnessIdentity ?? null,
    ...verifyWitnessAttestation(bundle, attestation, { allowlist }),
  }));
  for (const w of perWitness) {
    if (!w.ok) reasons.push(`witness "${w.identity ?? '?'}": ${w.reasons.join('; ')}`);
  }
  // Independence (ADR-0017): the signing identities must be distinct -- reject N-of-a-kind.
  const identities = perWitness.map((w) => w.identity);
  if (new Set(identities).size !== identities.length) reasons.push('witness identities are not distinct (N-of-a-kind)');
  // The quorum is re-derived over exactly the attested bundles: a pass verdict cannot be paired with other bundles.
  const verdict = compareWitnesses(witnesses.map((w) => w.bundle), { threshold });
  if (verdict.verdict !== 'pass') reasons.push(`re-computed corroboration verdict is ${verdict.verdict}, not pass`);
  return {
    schema: 'labview-benchmark-actor/acg-consume-decision-v1',
    consume: reasons.length === 0,
    reasons,
    verdict,
    witnesses: perWitness.map((w) => ({ identity: w.identity, ok: w.ok })),
  };
}

// --- CLI ---------------------------------------------------------------------------------------------------
// keygen  --identity <id> --key-out <priv.pem>                 -> writes the private key (0600), prints the public PEM
// sign    --bundle <f> --key <priv.pem> --identity <id> [--out <att.json>]
// verify  --allowlist <f> --witness <bundle.json>:<att.json> [--witness ...]   -> exit 0 iff consumable
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = {};
  const witnesses = [];
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--witness') witnesses.push(argv[(i += 1)]);
    else if (a.startsWith('--')) opt[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
  try {
    if (cmd === 'keygen') {
      if (!opt.identity || !opt['key-out']) throw new Error('keygen needs --identity and --key-out');
      const { privateKeyPem, publicKeyPem } = generateEnrolledKeypair();
      writeFileSync(opt['key-out'], privateKeyPem);
      chmodSync(opt['key-out'], 0o600);
      console.error(`wrote private key -> ${opt['key-out']} (0600). Enroll this identity with the public key below:`);
      console.log(JSON.stringify({ [opt.identity]: publicKeyPem }, null, 2));
    } else if (cmd === 'sign') {
      if (!opt.bundle || !opt.key || !opt.identity) throw new Error('sign needs --bundle, --key, --identity');
      const att = signBundle(readJson(opt.bundle), { privateKeyPem: readFileSync(opt.key, 'utf8'), identity: opt.identity });
      const out = JSON.stringify(att, null, 2) + '\n';
      if (typeof opt.out === 'string') { writeFileSync(opt.out, out); console.error(`wrote attestation -> ${opt.out}`); }
      else process.stdout.write(out);
    } else if (cmd === 'verify') {
      if (!opt.allowlist || witnesses.length === 0) throw new Error('verify needs --allowlist and >=1 --witness <bundle>:<att>');
      const allowlist = readJson(opt.allowlist);
      const pairs = witnesses.map((w) => {
        const [b, a] = w.split(':');
        return { bundle: readJson(b), attestation: readJson(a) };
      });
      const decision = verifyBeforeConsume({ witnesses: pairs, allowlist });
      console.log(JSON.stringify(decision, null, 2));
      process.exit(decision.consume ? 0 : 1);
    } else {
      console.error('usage: attest.mjs <keygen|sign|verify> ...');
      process.exit(2);
    }
  } catch (e) {
    console.error('attest: ' + e.message);
    process.exit(2);
  }
}
