#!/usr/bin/env node
// VIPM credential gate: the LabVIEW-add-on-manager capability that a cleanroom worker can advertise, and the
// CREDENTIAL-FROM-FILE activation the operator asked for -- "VIPM credentials read from a file with the command
// `vipm activate`". VIPM (vipm.io / JKI) ships a Rust `vipm` CLI (installed by the .deb to /usr/local/jki/vipm/
// support/vipm, symlinked onto PATH as /usr/local/bin/vipm). Grounded from the real 26.3.0 binary:
//   - `vipm about`  -> prints Edition / Installation ID / CLI Version / Valid Activation Code   (NO creds, rootless)
//   - `vipm activate --serial-number <S> --name <N> --email <E>`  -> activates VIPM Pro         (serial = the secret)
//   - `vipm login --token <T>` (or --email/--password) then `vipm whoami`                        (vipm.io account)
//   - `--json` is Professional-gated, so we parse the `about` TEXT, not JSON.
//   - Community Edition build/publish only works INSIDE A PUBLIC REPO (else Professional is required). The
//     binary says so itself: "VIPM Community Edition will work if the repository is public. Alternatively,
//     upgrade to VIPM Professional for private repositories." This gate detects repo visibility (an operator
//     -declared flag, or GitHub Actions' $GITHUB_EVENT_PATH repository.private/visibility) and encodes that
//     licensing rule in `editionGate`, so a Community worker in a PRIVATE repo is a SKIP, not a false pass.
//
// SECURITY (the whole point): the serial / token / password is READ FROM AN OPERATOR-PROVIDED FILE and passed
// straight to the CLI flag -- it NEVER passes through the model, and it NEVER lands in a receipt. Receipts carry
// only a non-reversible fingerprint (sha256 prefix) + which fields were present. `assertNoSecretLeak` enforces
// that invariant defensively before any receipt is returned. Dependency-free (node: builtins only).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VIPM_GATE_SCHEMA = 'labview-benchmark-actor/lba-vipm-gate-receipt@v1';

// The path the .deb postinst installs the CLI to (support/vipm) and the PATH symlink it creates.
const KNOWN_VIPM_PATHS = ['/usr/local/bin/vipm', '/usr/local/jki/vipm/support/vipm'];

// Resolve the `vipm` CLI without running anything: explicit arg -> $VIPM_CLI -> known install paths -> PATH.
// `includeInstalled:false` pins resolution to the explicit `vipmPath` only (deterministic tests; operational
// pinning of an exact CLI with no fallback).
export function detectVipmCli({ vipmPath, includeInstalled = true } = {}) {
  const candidates = [];
  if (vipmPath) candidates.push(vipmPath);
  if (includeInstalled) {
    if (process.env.VIPM_CLI) candidates.push(process.env.VIPM_CLI);
    candidates.push(...KNOWN_VIPM_PATHS);
    for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat('') : [''];
      for (const ext of exts) candidates.push(path.join(d, 'vipm' + ext));
    }
  }
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return { present: true, path: p }; } catch { /* keep looking */ }
  }
  return { present: false, path: null };
}

// Parse the TEXT output of `vipm about` into fields (warnings on other lines are ignored).
export function parseAbout(text) {
  const out = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const i = raw.indexOf(':');
    if (i <= 0) continue;
    const key = raw.slice(0, i).trim().toLowerCase();
    const val = raw.slice(i + 1).trim();
    if (key === 'vipm cli version') out.cliVersion = val;
    else if (key === 'vipm desktop version') out.desktopVersion = val;
    else if (key === 'installation id') out.installationId = val;
    else if (key === 'edition') out.edition = val;
    else if (key === 'valid through') out.validThrough = val;
    else if (key === 'build number') out.buildNumber = val;
    else if (key === 'valid activation code') out.validActivationCode = /^true$/i.test(val);
  }
  return out;
}

// Determine whether the current repository is PUBLIC. VIPM Community Edition's build/publish operations are
// licensed ONLY inside a public repository (else Professional is required) -- so the gate must know this. The
// grounded, dependency-free signals, in order: an operator-declared boolean; GitHub Actions' event payload
// ($GITHUB_EVENT_PATH -> repository.private / repository.visibility); or $GITHUB_REPOSITORY_VISIBILITY.
export function detectRepoVisibility({ declared, eventPath } = {}) {
  if (typeof declared === 'boolean') return { known: true, public: declared, visibility: declared ? 'public' : 'private', source: 'declared' };
  const ep = eventPath || process.env.GITHUB_EVENT_PATH;
  if (ep) {
    try {
      const ev = JSON.parse(fs.readFileSync(ep, 'utf8'));
      const repo = ev && ev.repository;
      if (repo && (typeof repo.private === 'boolean' || repo.visibility)) {
        const isPublic = repo.visibility ? repo.visibility === 'public' : repo.private === false;
        return { known: true, public: isPublic, visibility: repo.visibility || (repo.private ? 'private' : 'public'), source: 'github-event' };
      }
    } catch { /* fall through to env / unknown */ }
  }
  const v = process.env.GITHUB_REPOSITORY_VISIBILITY;
  if (v) return { known: true, public: v === 'public', visibility: v, source: 'github-env' };
  return { known: false, public: null, visibility: 'unknown', source: 'none' };
}

// Encode VIPM's edition licensing rule for build/publish: Professional works in ANY repo; Community works ONLY
// in a PUBLIC repo; Free is package-install-only (no build/publish). Returns the decision + the reason.
export function editionGate({ edition, repoPublic }) {
  const ed = String(edition || '').toLowerCase();
  if (ed === 'professional' || ed === 'enterprise') return { allowed: true, requiresPublicRepo: false, reason: `${edition} edition: build/publish allowed in any repository` };
  if (ed === 'community') {
    if (repoPublic === true) return { allowed: true, requiresPublicRepo: true, reason: 'Community Edition: allowed because the repository is public' };
    return { allowed: false, requiresPublicRepo: true, reason: repoPublic === false ? 'Community Edition build/publish requires a PUBLIC repository (this repo is private) -- upgrade to Professional for private repos' : 'Community Edition requires a public repository, but repo visibility is unknown' };
  }
  if (ed === 'free') return { allowed: false, requiresPublicRepo: false, reason: 'Free edition: package install only (no build/publish); use Community in a public repo, or Professional' };
  return { allowed: false, requiresPublicRepo: false, reason: `unknown edition '${edition}'` };
}

// Read an operator-provided credential file. Accepts JSON { serialNumber, name, email, token, password },
// or `key=value` lines (serial-number/serial/name/email/token/password), or a single raw line = the serial.
// SECRETS live only in the returned object; callers MUST redact before persisting.
export function readVipmCredential(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const trimmed = text.trim();
  const cred = {};
  const setKey = (k, v) => {
    const key = String(k).trim().toLowerCase().replace(/[_\s]+/g, '-');
    const val = String(v).trim();
    if (!val) return;
    if (key === 'serial-number' || key === 'serial' || key === 'serialnumber') cred.serialNumber = val;
    else if (key === 'name' || key === 'full-name') cred.name = val;
    else if (key === 'email') cred.email = val;
    else if (key === 'token' || key === 'auth-token') cred.token = val;
    else if (key === 'password') cred.password = val;
  };
  if (trimmed.startsWith('{')) {
    const obj = JSON.parse(trimmed);
    for (const [k, v] of Object.entries(obj)) setKey(k, v);
  } else if (/^[^\n=]+=[^\n]*$/m.test(trimmed) && /=/.test(trimmed)) {
    for (const line of trimmed.split(/\r?\n/)) {
      const j = line.indexOf('=');
      if (j > 0) setKey(line.slice(0, j), line.slice(j + 1));
    }
  } else if (trimmed && !trimmed.includes('\n')) {
    cred.serialNumber = trimmed; // a bare single line = the serial number
  }
  return cred;
}

// Non-reversible fingerprint so a receipt can REFERENCE a credential without exposing it.
export function fingerprint(secret) {
  return 'sha256:' + crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex').slice(0, 12);
}

// A redacted, receipt-safe summary of a credential: which fields were supplied + their fingerprints. No values.
export function credentialSummary(cred, sourceFile) {
  const s = { source: sourceFile ? path.resolve(sourceFile) : undefined, fields: [] };
  if (cred.serialNumber) { s.fields.push('serialNumber'); s.serialFingerprint = fingerprint(cred.serialNumber); }
  if (cred.name) s.fields.push('name');
  if (cred.email) { s.fields.push('email'); s.emailFingerprint = fingerprint(cred.email); }
  if (cred.token) { s.fields.push('token'); s.tokenFingerprint = fingerprint(cred.token); }
  if (cred.password) { s.fields.push('password'); s.passwordFingerprint = fingerprint(cred.password); }
  return s;
}

// Build argv for `vipm activate` / `vipm login`, injecting the secret (from file) straight into the flag.
export function buildActivateArgv(cred) {
  const a = ['activate'];
  if (cred.serialNumber) a.push('--serial-number', cred.serialNumber);
  if (cred.name) a.push('--name', cred.name);
  if (cred.email) a.push('--email', cred.email);
  return a;
}
export function buildLoginArgv(cred) {
  if (cred.token) return ['login', '--token', cred.token, '--no-store'];
  const a = ['login', '--no-store'];
  if (cred.email) a.push('--email', cred.email);
  if (cred.password) a.push('--password', cred.password);
  return a;
}

// Defensive invariant: NO raw secret may appear in a receipt. Throws if it does (caught by the gate's own tests).
export function assertNoSecretLeak(receipt, secrets) {
  const blob = JSON.stringify(receipt);
  for (const s of secrets) {
    if (s && String(s).length >= 3 && blob.includes(String(s))) {
      throw new Error('vipm-gate: SECRET LEAK -- a credential value appeared in the receipt (refusing to emit)');
    }
  }
}

// Default CLI runner: non-interactive, no --json (Pro-gated), captures stdout/stderr + exit code.
function defaultRun(bin, argv, extraEnv = {}) {
  const env = { ...process.env, VIPM_NONINTERACTIVE: '1', ...extraEnv };
  try {
    const stdout = execFileSync(bin, argv, { encoding: 'utf8', env, timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: String(stdout || ''), stderr: '' };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || e.message || '') };
  }
}

// Static capability probe for a worker to ADVERTISE over the bus HELLO->READY handshake: is `vipm` present and,
// if so, which Edition (Free/Community/Professional)? Runs `vipm about` ONCE at worker startup (no creds, no
// network). Synchronous + cheap; returns { present, edition?, cliVersion?, activated? }.
export function probeVipmCapability({ vipmPath, run = defaultRun, includeInstalled = true } = {}) {
  const d = detectVipmCli({ vipmPath, includeInstalled });
  if (!d.present) return { present: false };
  try {
    const about = parseAbout(run(d.path, ['about']).stdout);
    return { present: true, edition: about.edition, cliVersion: about.cliVersion, activated: about.validActivationCode === true };
  } catch { return { present: true }; }
}

// The gate. task = { mode: 'status'|'activate'|'login', credentialFile? }. `run(bin, argv)` is injectable so the
// deterministic self-test needs no real vipm and no secret. Returns a receipt whose verdict is:
//   - 'skip' when the vipm CLI is absent (like risky-test: the capability just isn't here);
//   - 'pass'/'fail' for status (probe), activate (edition upgraded / activation valid), login (whoami confirms).
export async function runVipmGate(task = {}, { vipmPath, run = defaultRun, includeInstalled = true } = {}) {
  const mode = task.mode || 'status';
  const resolved = detectVipmCli({ vipmPath, includeInstalled });
  const base = { schema: VIPM_GATE_SCHEMA, mode, vipm: { present: resolved.present, path: resolved.path } };
  if (!resolved.present) {
    return { ...base, verdict: 'skip', reason: 'vipm CLI not present -- VIPM capability unavailable here' };
  }

  const about = () => parseAbout(run(resolved.path, ['about']).stdout);
  const before = about();
  base.vipm.cliVersion = before.cliVersion;
  base.vipm.installationId = before.installationId;
  base.vipm.edition = before.edition;
  base.vipm.activated = before.validActivationCode === true;
  // Community-edition licensing awareness: can this edition build/publish HERE (i.e. is the repo public)?
  const repo = detectRepoVisibility({ declared: task.publicRepo, eventPath: task.eventPath });
  const eg = editionGate({ edition: before.edition, repoPublic: repo.public });
  base.repo = repo;
  base.editionGate = eg;

  if (mode === 'status') {
    const ok = !!before.edition;
    return { ...base, verdict: ok ? 'pass' : 'fail', reason: ok ? `VIPM present: edition=${before.edition} activated=${base.vipm.activated}; build/publish ${eg.allowed ? 'allowed' : 'blocked'} (${eg.reason})` : 'vipm about produced no edition' };
  }

  // Community/edition licensing gate for build/publish: PASS if allowed; SKIP (a licensing constraint, not a
  // harness fault) when the edition cannot build/publish here -- e.g. Community Edition in a PRIVATE repo. This
  // is the operator's rule: Community Edition only works inside a public repo.
  if (mode === 'community' || mode === 'build') {
    return { ...base, verdict: eg.allowed ? 'pass' : 'skip', reason: eg.reason };
  }

  if (mode === 'activate' || mode === 'login') {
    if (!task.credentialFile) return { ...base, verdict: 'fail', reason: `mode=${mode} requires a credentialFile (operator-provided)` };
    const cred = readVipmCredential(task.credentialFile);
    const secrets = [cred.serialNumber, cred.token, cred.password].filter(Boolean);
    const need = mode === 'activate' ? cred.serialNumber : (cred.token || (cred.email && cred.password));
    if (!need) {
      const r = { ...base, verdict: 'fail', reason: `credential file has no ${mode === 'activate' ? 'serialNumber' : 'token or email+password'}`, credential: credentialSummary(cred, task.credentialFile) };
      assertNoSecretLeak(r, secrets); return r;
    }
    const argv = mode === 'activate' ? buildActivateArgv(cred) : buildLoginArgv(cred);
    const res = run(resolved.path, argv);
    const after = about();
    let verdict, reason;
    if (mode === 'activate') {
      const upgraded = after.validActivationCode === true && (after.edition !== 'Free');
      const ok = res.code === 0 && upgraded && !/error:/i.test(res.stdout + res.stderr);
      verdict = ok ? 'pass' : 'fail';
      reason = ok ? `activated: edition ${before.edition} -> ${after.edition}` : `activation not confirmed (code=${res.code} edition=${after.edition})`;
    } else {
      const who = run(resolved.path, ['whoami']);
      const loggedIn = who.code === 0 && /@/.test(who.stdout) && !/not logged in|error:/i.test(who.stdout + who.stderr);
      verdict = res.code === 0 && loggedIn ? 'pass' : 'fail';
      reason = loggedIn ? 'logged in to vipm.io (whoami confirms an account)' : 'login did not establish a vipm.io session';
    }
    const receipt = {
      ...base,
      verdict,
      reason,
      credential: credentialSummary(cred, task.credentialFile),
      before: { edition: before.edition, activated: base.vipm.activated },
      after: { edition: after.edition, activated: after.validActivationCode === true },
    };
    assertNoSecretLeak(receipt, secrets); // defence in depth: a secret must NEVER reach the receipt
    return receipt;
  }

  return { ...base, verdict: 'fail', reason: `unknown mode '${mode}'` };
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    if (k.startsWith('--')) { const key = k.slice(2); const v = argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[++i] : true; o[key] = v; }
  }
  return o;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const a = parseArgs(process.argv.slice(2));
  runVipmGate({ mode: a.mode || 'status', credentialFile: a.credential || a['credential-file'] }, { vipmPath: a.vipm })
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.verdict === 'fail' ? 1 : 0); })
    .catch((e) => { console.error('vipm-gate error:', e.message); process.exit(1); });
}
