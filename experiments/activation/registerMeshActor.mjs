#!/usr/bin/env node
// Mesh-actor registration, gated on activation (LBA-REQ-039, realizes ADR-0023 Phase 1). ADR-0023's
// onboarding invariant is: confirm LabVIEW activation BEFORE registering the VM as a mesh actor. This module
// enforces that fail-closed -- it will only emit a golden mesh-actors.csv row when the activation-receipt@1
// validates as ACTIVATED (buildActivationReceipt.mjs). An unactivated / tampered receipt is REFUSED.
//
// Registry schema (cleanroom/ubuntu-labview/mesh-actors.csv):
//   role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password
// The real mesh-actors.csv is gitignored and its passwords are AGENT-generated locally; this module only
// composes the row deterministically (password stays the AGENT_GENERATED placeholder).

import { validateActivationReceipt } from './buildActivationReceipt.mjs';

export const REGISTRY_HEADER = 'role,actor_id,hostname,username,ip,tcp_port,udp_port,node_type,password';
export const GOLDEN_DEFAULTS = {
  role: 'golden', actor_id: 'golden', hostname: 'actor', username: 'actor',
  ip: '192.168.56.10', tcp_port: '7420', udp_port: '7421', node_type: 'both', password: 'AGENT_GENERATED',
};
const COLS = ['role', 'actor_id', 'hostname', 'username', 'ip', 'tcp_port', 'udp_port', 'node_type', 'password'];

// Register the golden VM as a mesh actor -- ONLY if its activation receipt confirms activation.
// Idempotent: re-registering the same role+actor_id replaces the row rather than duplicating it.
export function registerGoldenActor({ receipt, registry = '', actor = {} } = {}) {
  const v = validateActivationReceipt(receipt);
  if (!v.activated) {
    return {
      ok: false, refused: true, csv: registry, row: null,
      findings: ['activation not confirmed — refusing to register the golden VM as a mesh actor', ...v.findings],
    };
  }
  const row = { ...GOLDEN_DEFAULTS, ...actor };
  const cells = COLS.map((c) => String(row[c]));

  const lines = String(registry).split(/\r?\n/);
  const comments = lines.filter((l) => l.trim().startsWith('#'));
  const data = lines.filter((l) => l.trim() && !l.trim().startsWith('#'));
  const rows = data
    .filter((l) => !l.startsWith('role,actor_id'))            // drop any existing header
    .map((l) => l.split(','))
    .filter((c) => `${c[0]}/${c[1]}` !== `${row.role}/${row.actor_id}`); // dedup by role+actor_id
  rows.push(cells);
  // deterministic order: golden first, then mesh rows by numeric actor_id
  rows.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1]), undefined, { numeric: true }) : a[0] === 'golden' ? -1 : 1));

  const csv = [...comments, REGISTRY_HEADER, ...rows.map((c) => c.join(','))].join('\n') + '\n';
  return { ok: true, refused: false, csv, row, findings: [] };
}
