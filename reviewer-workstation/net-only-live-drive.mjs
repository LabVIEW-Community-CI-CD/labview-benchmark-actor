#!/usr/bin/env node
// net-only-live-drive-receipt@1 builder + validator (LBA-REQ-068, realizes ADR-0049). Seals, as a committed
// fail-closed receipt, that the host drove the reviewer VM's Copilot agent to run the RELEASED net-only
// `lbabus` (collab-cli 0.15.0, pulled from the immutable `collab-cli-v0.15.0` GitHub Release) and the VM
// reported task-correlated results back over the `lbabus net` TCP bus -- the SOLE coordination path, since the
// released CLI has no GitHub-Discussion transport (init/post/poll/wait/delta are gone, ADR-0047/LBA-REQ-067).
//
// This is the productized companion to LBA-REQ-059/ADR-0039 (which proved the read-back CORRELATION mechanism
// while the CLI still shipped the Discussion transport): LBA-REQ-068 proves the loop end-to-end with the
// RELEASED net-only binary on the VM and commits the real drives (senderId WIN) as durable, gated evidence.
//
// Pure + rg-free + offline: the committed receipt re-derives its digest + verdict byte-stably in CI (which has
// no VM / network). The gate fails closed on a drive that did not close the loop over net (a non-WIN sender, a
// disallowed type, an unmatched reply), an incomplete net-only CLI proof (a retired Discussion command not
// recorded rejected, or no released release tag), a forged verdict, or a tampered digest.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

export const RECEIPT_SCHEMA = 'labview-benchmark-actor/net-only-live-drive-receipt@1';
export const REQUIREMENT = 'LBA-REQ-068';
export const ADR = 'ADR-0049';

// The `net` envelope type set a drive reply may carry (BusWire.Types, ADR-0003/0039). A well-formed drive
// closes the loop with one of these types; the discussion transport is NOT in this set (it is gone).
export const NET_TYPES = ['HELLO', 'CLAIM', 'ACK', 'HANDOFF', 'DONE', 'PROGRESS', 'NOTE', 'RESOLVED', 'REFINE', 'BLOCKED'];

// The retired GitHub-Discussion subcommands the RELEASED net-only CLI must reject (observed on the VM). The
// net-only proof is complete only if every one of these was recorded rejected.
export const RETIRED_COMMANDS = ['init', 'post', 'poll', 'wait', 'delta'];

// Machine-independent identity of a single live drive: what closed the loop (type + task + WIN sender +
// payload) and whether it matched. Excludes wall-clock / screenshots / host paths.
export function driveIdentity(d) {
  return {
    drive: d?.drive ?? null,
    vm: d?.vm ?? null,
    type: d?.frame?.type ?? null,
    task: d?.frame?.task ?? null,
    senderId: d?.frame?.senderId ?? null,
    payload: d?.frame?.payload ?? null,
    matched: d?.matched === true,
  };
}

// A drive is well-formed iff it CLOSED THE LOOP over net: a matched WIN reply of an allowed net type carrying
// a non-empty task id + payload. Anything else (non-WIN sender, disallowed type, unmatched) fails closed.
export function driveOk(d) {
  return !!d && d.matched === true && !!d.frame
    && d.frame.senderId === 'WIN'
    && NET_TYPES.includes(d.frame.type)
    && typeof d.frame.task === 'string' && d.frame.task.length > 0
    && typeof d.frame.payload === 'string' && d.frame.payload.length > 0;
}

// The CLI net-only proof is valid iff it names the released version + a `collab-cli-v*` tag AND records EVERY
// retired Discussion command rejected on the VM AND observed an "unknown command" rejection there.
export function cliNetOnlyOk(c) {
  return !!c
    && typeof c.releasedVersion === 'string' && c.releasedVersion.length > 0
    && typeof c.releaseTag === 'string' && c.releaseTag.startsWith('collab-cli-v')
    && Array.isArray(c.retiredCommandsRejected)
    && RETIRED_COMMANDS.every((k) => c.retiredCommandsRejected.includes(k))
    && typeof c.observedOnVm === 'string' && /unknown command/.test(c.observedOnVm);
}

// The capability is proven iff >=1 drive closed the loop over net AND the net-only CLI proof is complete.
export function decideDrive({ drives, cliNetOnly }) {
  return Array.isArray(drives) && drives.length >= 1 && drives.every(driveOk) && cliNetOnlyOk(cliNetOnly);
}

// Digest over the verdict-bearing fields ONLY (the drives' identity + the net-only proof + the verdict), NOT
// the descriptive prose (transport blurb, capability, reviewerVm, note, capturedAt), which may be reworded.
function canonical(receipt) {
  return JSON.stringify({
    schema: receipt.schema,
    requirement: receipt.requirement,
    adr: receipt.adr,
    cliNetOnly: {
      releasedVersion: receipt.cliNetOnly?.releasedVersion ?? null,
      releaseTag: receipt.cliNetOnly?.releaseTag ?? null,
      retiredCommandsRejected: Array.isArray(receipt.cliNetOnly?.retiredCommandsRejected) ? receipt.cliNetOnly.retiredCommandsRejected : null,
      observedOnVm: receipt.cliNetOnly?.observedOnVm ?? null,
    },
    drives: Array.isArray(receipt.drives) ? receipt.drives.map(driveIdentity) : null,
    verdict: { netOnlyDriveProven: receipt.verdict?.netOnlyDriveProven },
  });
}

export function digestReceipt(receipt) {
  return createHash('sha256').update(canonical(receipt)).digest('hex');
}

// Build a net-only-live-drive receipt from a batch of captured drives + the released-CLI net-only proof.
export function buildReceipt(capture) {
  const drives = Array.isArray(capture.drives) ? capture.drives : [];
  const cliNetOnly = capture.cliNetOnly ?? null;
  const netOnlyDriveProven = decideDrive({ drives, cliNetOnly });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    requirement: REQUIREMENT,
    adr: ADR,
    transport: capture.transport
      ?? 'lbabus net -- bus-msg@1, ADR-0003/0004 (TCP 7420; guest->host via VirtualBox NAT 10.0.2.2). NET-ONLY: the released CLI has no GitHub-Discussion transport (ADR-0047).',
    capability: capture.capability ?? null,
    reviewerVm: capture.reviewerVm ?? null,
    cliNetOnly,
    drives,
    capturedAt: capture.capturedAt ?? null,
    note: capture.note ?? null,
    verdict: {
      netOnlyDriveProven,
      reason: netOnlyDriveProven
        ? `${drives.length} task-correlated drive(s) from the reviewer VM (senderId WIN) over lbabus net; the released ${cliNetOnly.releaseTag} CLI rejects ${RETIRED_COMMANDS.join('/')}`
        : 'a drive did not close the loop over net, or the released-CLI net-only proof is incomplete',
    },
  };
  receipt.digest = digestReceipt(receipt);
  return receipt;
}

// Validate a committed receipt: schema/requirement/adr, every drive closed the loop over net, the net-only CLI
// proof is complete, the verdict matches the rule, and the digest re-derives (tamper-evident). Fail-closed.
export function validateReceipt(receipt) {
  const findings = [];
  if (!receipt || receipt.schema !== RECEIPT_SCHEMA) findings.push(`schema must be ${RECEIPT_SCHEMA}`);
  if (receipt?.requirement !== REQUIREMENT) findings.push(`requirement must be ${REQUIREMENT}`);
  if (receipt?.adr !== ADR) findings.push(`adr must be ${ADR}`);
  if (!Array.isArray(receipt?.drives) || receipt.drives.length < 1) {
    findings.push('at least one live drive is required');
  } else {
    receipt.drives.forEach((d, i) => {
      if (!driveOk(d)) findings.push(`drive[${i}] did not close the loop over net (need a matched WIN reply of an allowed net type with a task + payload)`);
    });
  }
  if (!cliNetOnlyOk(receipt?.cliNetOnly)) {
    findings.push('cliNetOnly must name the released version + a collab-cli-v* tag and record every retired Discussion command rejected on the VM (with an observed "unknown command")');
  }
  const expectedVerdict = decideDrive({ drives: receipt?.drives, cliNetOnly: receipt?.cliNetOnly });
  if (receipt?.verdict?.netOnlyDriveProven !== expectedVerdict) {
    findings.push(`verdict.netOnlyDriveProven=${receipt?.verdict?.netOnlyDriveProven} contradicts the rule (${expectedVerdict})`);
  }
  if (receipt?.digest !== digestReceipt(receipt)) findings.push('digest does not match the verdict-bearing fields (tampered)');
  return { ok: findings.length === 0, proofOk: !!receipt?.verdict?.netOnlyDriveProven && findings.length === 0, findings };
}

// CLI: validate the committed receipt next to this module (offline, deterministic). Exit 1 on any finding.
function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const receiptPath = join(here, 'net-only-live-drive-receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  const result = validateReceipt(receipt);
  if (!result.ok) {
    console.error(`[net-only-live-drive] FAIL ${receiptPath}`);
    for (const f of result.findings) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`[net-only-live-drive] OK ${REQUIREMENT}: ${receipt.drives.length} net drive(s), released ${receipt.cliNetOnly.releaseTag}, verdict proven=${result.proofOk}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
