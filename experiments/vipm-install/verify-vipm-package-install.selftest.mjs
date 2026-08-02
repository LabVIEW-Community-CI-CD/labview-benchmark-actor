// Self-test for vipmInstallReceipt.mjs -- VIPM FUNCTIONALLY installs a LabVIEW community package
// (LBA-REQ-046, realizes ADR-0023 Phase 1). Asserts the committed g-cli install receipt is valid + proves
// installed, that it replays deterministically (rebuild -> identical digest), and that validation FAILS
// CLOSED on tampering: error status, no files-installed, empty vi.lib, forged verdict, tampered digest, and
// the designated self-test package (g-cli) absent. Pure + rg-free + offline (no VIPM / LabVIEW / ripgrep).
// Run: node verify-vipm-package-install.selftest.mjs.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RECEIPT_SCHEMA, buildVipmInstallReceipt, validateVipmInstallReceipt, digestReceipt } from './vipmInstallReceipt.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const receipt = JSON.parse(readFileSync(join(here, 'fixtures', 'vipm-package-install-receipt.json'), 'utf8'));
let passed = 0;
const ok = (m) => { console.log(`  PASS  ${m}`); passed += 1; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// 1. the committed receipt is valid and proves the VIPM functional install (g-cli, the designated self-test)
{
  const r = validateVipmInstallReceipt(receipt);
  assert.ok(r.ok && r.installed, `expected a valid installed receipt; findings: ${r.findings.join('; ')}`);
  assert.equal(receipt.schema, RECEIPT_SCHEMA, 'receipt schema');
  const gcli = receipt.packages.find((p) => p.name === 'wiresmith_technology_lib_g_cli');
  assert.ok(gcli && gcli.version === '3.0.1.98' && gcli.status === 'No Errors' && gcli.filesInstalled > 0,
    'g-cli (the designated self-test package) is installed with No Errors and real files');
  ok(`committed receipt valid: VIPM ${receipt.vipm.version} installed ${receipt.packages.length} packages incl g-cli 3.0.1.98`);
}

// 2. deterministic replay: rebuilding from the receipt's captured fields yields the identical digest
{
  const rebuilt = buildVipmInstallReceipt(receipt);
  assert.equal(rebuilt.digest, receipt.digest, 'rebuilt digest matches the committed receipt (deterministic)');
  assert.equal(rebuilt.verdict.installed, true, 'rebuilt verdict is installed');
  ok('receipt replays deterministically (rebuild -> identical digest)');
}

// 3. fail-closed: a package with an error status is rejected (verdict rule + per-package check)
{
  const badStatus = clone(receipt);
  badStatus.packages[0].status = 'Errors';
  badStatus.digest = digestReceipt(badStatus); // re-seal so only the RULE, not the digest, must reject
  const r = validateVipmInstallReceipt(badStatus);
  assert.equal(r.ok, false, 'a package with an error status FAILS');
  assert.ok(r.findings.some((f) => /not cleanly installed/.test(f) || /contradicts the rule/.test(f)), 'names the failure');
  ok('fail-closed: package status != "No Errors" rejected');
}

// 4. fail-closed: a package that left no files on disk is not proven installed
{
  const noFiles = clone(receipt);
  noFiles.packages[0].filesInstalled = 0;
  const rebuilt = buildVipmInstallReceipt(noFiles); // recompute verdict + digest honestly
  const r = validateVipmInstallReceipt(rebuilt);
  assert.equal(r.installed, false, 'a package with 0 files-installed is not proven installed');
  assert.ok(r.findings.some((f) => /not cleanly installed/.test(f)), 'names the empty package');
  ok('fail-closed: filesInstalled=0 rejected');
}

// 5. fail-closed: no files landed in vi.lib
{
  const noViLib = clone(receipt);
  noViLib.viLib.fileCount = 0;
  const rebuilt = buildVipmInstallReceipt(noViLib);
  const r = validateVipmInstallReceipt(rebuilt);
  assert.equal(r.ok, false, 'a receipt where vi.lib gained no files FAILS');
  assert.ok(r.findings.some((f) => /vi\.lib gained no files/.test(f)), 'names the empty vi.lib');
  ok('fail-closed: vi.lib fileCount=0 rejected');
}

// 6. fail-closed: forged verdict (installed=true while a dependency failed) is caught by the rule
{
  const forged = clone(receipt);
  forged.packages[1].status = 'Errors';   // a dependency failed...
  forged.verdict.installed = true;         // ...but the receipt still claims installed
  forged.digest = digestReceipt(forged);   // re-seal the lie
  const r = validateVipmInstallReceipt(forged);
  assert.equal(r.ok, false, 'installed=true while a package failed is rejected');
  assert.ok(r.findings.some((f) => /contradicts the rule/.test(f) || /not cleanly installed/.test(f)), 'names the contradiction');
  ok('fail-closed: forged verdict (failed package but installed=true) rejected');
}

// 7. fail-closed: a tampered digest
{
  const tampered = clone(receipt);
  tampered.digest = '0'.repeat(64);
  const r = validateVipmInstallReceipt(tampered);
  assert.equal(r.ok, false, 'a tampered digest FAILS');
  assert.ok(r.findings.some((f) => /digest/.test(f)), 'names the digest');
  ok('fail-closed: tampered digest rejected');
}

// 8. fail-closed: the designated self-test package (g-cli) absent from the installed set
{
  const noGcli = clone(receipt);
  noGcli.packages = noGcli.packages.filter((p) => p.name !== 'wiresmith_technology_lib_g_cli');
  const rebuilt = buildVipmInstallReceipt(noGcli); // remaining deps still "installed", but referenced pkg gone
  const r = validateVipmInstallReceipt(rebuilt);
  assert.equal(r.ok, false, 'the designated self-test package (g-cli) missing FAILS');
  assert.ok(r.findings.some((f) => /referenced package/.test(f)), 'names the missing referenced package');
  ok('fail-closed: designated g-cli package absent rejected');
}

console.log(`\nverify-vipm-package-install.selftest: ${passed}/${passed} checks passed`);
