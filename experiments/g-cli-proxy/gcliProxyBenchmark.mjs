#!/usr/bin/env node
// g-cli-proxy-proof@1 builder + validator (LBA-REQ-052, realizes ADR-0033). Proves the g-cli launcher -- the
// Linux g-cli "proxy" that the ni/labview-icon-editor CI drives -- built FROM ITS RUST SOURCE and works on
// this host. On Linux g-cli ships no prebuilt binary: the launcher is a Rust program (the `rust-proxy/`
// crate in G-CLI/G-CLI) that opens a TCP server, launches LabVIEW on the target VI, and streams the VI's
// arguments / output / exit code back over the socket. This is the enabler for the TESTER actor of the
// 2-actor icon-editor grid (`g-cli ... lunit`), the companion to the builder actor (LBA-REQ-051).
//
// The proof identity (tool + version + source commit + operation + launch target + args in + echoed text +
// exit code + LabVIEW version/bitness) is machine-independent, so the SAME round-trip is comparable across
// planes; the Rust build time, the rustc/toolchain version, and the host install path are descriptive
// metrics, NOT in the resultHash or digest.
//
// Pure + rg-free + offline: a committed receipt re-derives its resultHash + verdict + digest byte-stably in
// CI (which has no Rust / LabVIEW). The gate fails closed on a stale/tampered resultHash, a forged verdict,
// an echo that does not match the args sent, a non-zero exit, or a tampered digest.

import { createHash } from 'node:crypto';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/g-cli-proxy-proof@1';

// Machine-independent proof identity: what was built (tool + version + source commit), what was exercised
// (operation + launch target + the args sent + the text echoed back + the exit code) and which LabVIEW
// answered (version + bitness). Excludes build time, toolchain version, and the host-specific install path.
export function computeResultHash({ tool, version, sourceCommit, operation, launchTargetVi, argsIn, echoedText, exitCode, labviewVersion, labviewBitness }) {
  const canon = JSON.stringify({
    tool: tool ?? null,
    version: version ?? null,
    sourceCommit: sourceCommit ?? null,
    operation: operation ?? null,
    launchTargetVi: launchTargetVi ?? null,
    argsIn: Array.isArray(argsIn) ? argsIn : null,
    echoedText: echoedText ?? null,
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    labviewVersion: labviewVersion ?? null,
    labviewBitness: labviewBitness ?? null,
  });
  return createHash('sha256').update(canon).digest('hex');
}

// The round-trip echoed correctly iff LabVIEW returned exactly the args g-cli sent, tab-joined.
export function echoMatches(argsIn, echoedText) {
  return Array.isArray(argsIn) && argsIn.length > 0 && typeof echoedText === 'string'
    && echoedText === argsIn.join('\t');
}

// The proof passes iff the round-trip echoed correctly, LabVIEW exited 0, and the built tool is identified.
export function decideProof({ exitCode, roundTripEchoed, version, sourceCommit }) {
  return roundTripEchoed === true && exitCode === 0
    && typeof version === 'string' && version.length > 0
    && typeof sourceCommit === 'string' && sourceCommit.length > 0;
}

// Digest over the verdict-bearing fields (NOT build time / toolchain / install path, which vary by machine).
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    tool: receipt.tool ?? null,
    version: receipt.version ?? null,
    sourceCommit: receipt.source?.commit ?? null,
    operation: receipt.operation ?? null,
    launchTargetVi: receipt.launchTargetVi ?? null,
    argsIn: Array.isArray(receipt.argsIn) ? receipt.argsIn : null,
    echoedText: receipt.echoedText ?? null,
    exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
    labviewVersion: receipt.labview?.version ?? null,
    labviewBitness: receipt.labview?.bitness ?? null,
    resultHash: receipt.resultHash ?? null,
    verdict: { proofOk: receipt.verdict?.proofOk },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a g-cli-proxy-proof@1 receipt from captured build + round-trip evidence (deterministic + sealed).
export function buildGcliReceipt(capture) {
  const argsIn = Array.isArray(capture.argsIn) ? capture.argsIn : [];
  const echoedText = capture.echoedText ?? null;
  const exitCode = Number.isInteger(capture.exitCode) ? capture.exitCode : null;
  const roundTripEchoed = echoMatches(argsIn, echoedText);
  const labview = capture.labview ?? null;
  const resultHash = computeResultHash({
    tool: capture.tool ?? 'g-cli', version: capture.version, sourceCommit: capture.source?.commit,
    operation: capture.operation, launchTargetVi: capture.launchTargetVi, argsIn, echoedText, exitCode,
    labviewVersion: labview?.version, labviewBitness: labview?.bitness,
  });
  const proofOk = decideProof({ exitCode, roundTripEchoed, version: capture.version, sourceCommit: capture.source?.commit });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    plane: capture.plane ?? null,
    host: capture.host ?? null,
    tool: capture.tool ?? 'g-cli',
    version: capture.version ?? null,
    source: capture.source ?? null,
    toolchain: capture.toolchain ?? null,
    operation: capture.operation ?? null,
    launchTargetVi: capture.launchTargetVi ?? null,
    labview,
    detectedInstall: capture.detectedInstall ?? null,
    argsIn,
    echoedText,
    roundTripEchoed,
    exitCode,
    timing: { buildSeconds: capture.buildSeconds ?? null, roundTripSeconds: capture.roundTripSeconds ?? null },
    resultHash,
    note: capture.note ?? null,
    verdict: {
      proofOk,
      reason: proofOk
        ? `g-cli ${capture.version} (built from ${capture.source?.commit?.slice(0, 7)}) drove host LabVIEW ${labview?.version} to echo ${argsIn.length} args, exit 0`
        : 'g-cli round-trip did not echo the args sent or LabVIEW did not exit 0',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema, echo match, resultHash re-derivation, verdict rule, digest integrity.
export function validateGcliReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (!echoMatches(receipt?.argsIn, receipt?.echoedText)) findings.push('echoedText does not equal the args sent, tab-joined (round-trip mismatch)');
  if (receipt?.roundTripEchoed !== echoMatches(receipt?.argsIn, receipt?.echoedText)) findings.push('roundTripEchoed contradicts the echo check');
  const expectedHash = computeResultHash({
    tool: receipt?.tool, version: receipt?.version, sourceCommit: receipt?.source?.commit,
    operation: receipt?.operation, launchTargetVi: receipt?.launchTargetVi, argsIn: receipt?.argsIn,
    echoedText: receipt?.echoedText, exitCode: receipt?.exitCode,
    labviewVersion: receipt?.labview?.version, labviewBitness: receipt?.labview?.bitness,
  });
  if (receipt?.resultHash !== expectedHash) findings.push('resultHash does not match the recorded proof (stale/tampered)');
  const expectedVerdict = decideProof({
    exitCode: receipt?.exitCode, roundTripEchoed: echoMatches(receipt?.argsIn, receipt?.echoedText),
    version: receipt?.version, sourceCommit: receipt?.source?.commit,
  });
  if (receipt?.verdict?.proofOk !== expectedVerdict) findings.push(`verdict.proofOk=${receipt?.verdict?.proofOk} contradicts the rule (${expectedVerdict})`);
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.proofOk && findings.length === 0, resultHash: receipt?.resultHash, findings };
}
