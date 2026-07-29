#!/usr/bin/env node
// Integrity + canonicalization for the extension-embedded AGENTS.md (issue #98). The manifest
// `extension-agents/agents.manifest.json` = { schema, version, sha256 } pins the AGENTS.md content by a
// sha256 over its CANONICAL body (LF, single trailing newline). Per WIN's #98 enhancement, the drift gate is
// then a pure `manifest.sha256 == sha256(AGENTS.md)` + valid-semver check -- no header/stamp parsing.
//
//   node scripts/agentsManifest.mjs            # verify the manifest matches AGENTS.md (exit 0 ok / 1 drift)
//   node scripts/agentsManifest.mjs --refresh  # recompute manifest.sha256 from AGENTS.md (after an edit)
//
// Semver discipline (issue #98): patch = editorial, minor = new section, major = restructure. Bump the
// manifest `version` whenever the content changes, then `--refresh` to update the sha256.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const AGENTS_MD = join(here, '..', 'extension-agents', 'AGENTS.md');
export const MANIFEST = join(here, '..', 'extension-agents', 'agents.manifest.json');
export const SCHEMA = 'labview-benchmark-actor/extension-agents@v1';
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Canonical body: LF line endings, no trailing whitespace, exactly one trailing newline. This MUST stay
 * byte-identical to the TS copy in `src/extension.ts` (checkAgents) so a Windows CRLF checkout hashes the same.
 */
export function canonicalizeAgents(text) {
  return text.replace(/\r\n/g, '\n').replace(/[\s\uFEFF]*$/, '') + '\n';
}

export function agentsSha256(text) {
  return createHash('sha256').update(canonicalizeAgents(text), 'utf8').digest('hex');
}

export function readManifest() {
  if (!existsSync(MANIFEST)) {
    return { schema: SCHEMA, version: '0.1.0', sha256: '' };
  }
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** Verify the manifest is well-formed and its sha256 matches the current AGENTS.md. Returns { ok, errors }. */
export function verifyManifest() {
  const errors = [];
  if (!existsSync(AGENTS_MD)) {
    return { ok: false, errors: [`AGENTS.md not found at ${AGENTS_MD}`] };
  }
  if (!existsSync(MANIFEST)) {
    return { ok: false, errors: [`manifest not found at ${MANIFEST}`] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`manifest unreadable: ${e.message}`] };
  }
  if (manifest.schema !== SCHEMA) {
    errors.push(`schema must be ${SCHEMA} (got ${JSON.stringify(manifest.schema)})`);
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    errors.push(`version must be x.y.z semver (got ${JSON.stringify(manifest.version)})`);
  }
  const actual = agentsSha256(readFileSync(AGENTS_MD, 'utf8'));
  if (manifest.sha256 !== actual) {
    errors.push(
      `sha256 drift: manifest ${manifest.sha256 || '(empty)'} != AGENTS.md ${actual} ` +
        '(edit AGENTS.md -> bump version -> `node scripts/agentsManifest.mjs --refresh`)',
    );
  }
  return { ok: errors.length === 0, errors };
}

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--refresh')) {
    const manifest = readManifest();
    manifest.schema = SCHEMA;
    manifest.sha256 = agentsSha256(readFileSync(AGENTS_MD, 'utf8'));
    writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`refreshed ${MANIFEST}: v${manifest.version} sha256:${manifest.sha256.slice(0, 12)}`);
    process.exit(0);
  }
  const { ok, errors } = verifyManifest();
  if (!ok) {
    console.error('extension AGENTS.md manifest INVALID:');
    for (const e of errors) {
      console.error('  - ' + e);
    }
    process.exit(1);
  }
  const m = readManifest();
  console.log(`extension AGENTS.md manifest OK: v${m.version} sha256:${m.sha256.slice(0, 12)}`);
  process.exit(0);
}
