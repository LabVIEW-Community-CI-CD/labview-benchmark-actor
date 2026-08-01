#!/usr/bin/env node
// grid-tools.mjs -- ACG MCP orchestration surface (ADR-0020, LBA-REQ-029).
//
// Exposes the corroboration grid's operations to agents through the SAME dependency-free JSON-RPC 2.0 MCP contract
// as the ADR-0012 server (identical tool shape + protocol, no SDK). The deterministic tools compose the built grid
// engines -- run_quorum / get_confidence (ADR-0015), verify_attestation (ADR-0016), check_independence (ADR-0017),
// assemble_witness (ADR-0014); spin_up_witness / teardown return the deterministic provisioning PLAN (live
// execution -- creating/destroying a real codespace or VM -- is the operator step, not run inside a tool call).
// Dependency-free (Node builtins + the grid engines).

import { compareWitnesses } from '../acg-quorum/compare-witnesses.mjs';
import { assembleWitness } from '../acg-quorum/assemble-witness.mjs';
import { verifyBeforeConsume } from '../acg-provenance/attest.mjs';
import { assessIndependence, enrolledEnvironmentSet } from '../acg-independence/independence.mjs';

export const ACG_GRID_MCP_SERVER_NAME = 'labview-benchmark-actor/acg-grid';
export const ACG_GRID_MCP_PROTOCOL_VERSION = '2025-06-18';
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

// Argument-shape failures map to JSON-RPC -32602; genuine tool-execution failures stay inside the result envelope.
export class McpArgumentError extends Error {}
const asObject = (a) => {
  if (typeof a !== 'object' || a === null) throw new McpArgumentError('arguments must be an object');
  return a;
};
const reqArray = (a, k) => {
  const v = asObject(a)[k];
  if (!Array.isArray(v) || v.length === 0) throw new McpArgumentError(`"${k}" must be a non-empty array`);
  return v;
};

const SPIN_UP_PLAN = {
  CODESPACE: 'gh codespace create -R <owner>/<repo> -b develop --devcontainer-path .devcontainer/cleanroom-witness/devcontainer.json',
  VBOX: 'bash experiments/multi-vm-topology/clone-cleanroom-worker.sh <clone> <ssh_port> <worker_port> <actor>',
  WIN: 'provision the Windows reviewer VM (reviewer-workstation/provision.ps1)',
};
const TEARDOWN_PLAN = {
  CODESPACE: 'gh codespace delete -c <witness-id>',
  VBOX: 'VBoxManage unregistervm <witness-id> --delete',
  WIN: 'power off + restore the reviewer VM snapshot',
};

// Tool handlers -- each returns a plain result object (throws McpArgumentError on a bad argument shape).
const HANDLERS = {
  run_quorum: (args) => compareWitnesses(reqArray(args, 'bundles'), { threshold: asObject(args).threshold }),
  get_confidence: (args) => {
    const q = compareWitnesses(reqArray(args, 'bundles'), { threshold: asObject(args).threshold });
    return { verdict: q.verdict, confidence: q.confidence, threshold: q.threshold, witnesses: q.witnesses, concurring: q.concurring };
  },
  verify_attestation: (args) => verifyBeforeConsume({ witnesses: reqArray(args, 'witnesses'), allowlist: asObject(args).allowlist ?? {} }),
  check_independence: (args) => assessIndependence(reqArray(args, 'witnesses'), { enrolledEnvironments: enrolledEnvironmentSet(asObject(args).enrollment ?? { environments: [] }) }),
  assemble_witness: (args) => assembleWitness(asObject(args)),
  spin_up_witness: (args) => {
    const plane = asObject(args).plane;
    const command = SPIN_UP_PLAN[plane];
    if (!command) throw new McpArgumentError('"plane" must be one of CODESPACE|VBOX|WIN');
    return { action: 'spin_up_witness', plane, command, executed: false, note: 'returns the provisioning plan; live execution is the operator step' };
  },
  teardown: (args) => {
    const plane = asObject(args).plane;
    const command = TEARDOWN_PLAN[plane];
    if (!command) throw new McpArgumentError('"plane" must be one of CODESPACE|VBOX|WIN');
    return { action: 'teardown', plane, command, executed: false, note: 'returns the teardown plan; live execution is the operator step' };
  },
};

// The authoritative grid tool registry -- `tools/list` publishes exactly this set (ADR-0020 names + the engine tools).
export const ACG_GRID_TOOLS = [
  { name: 'spin_up_witness', description: 'Return the provisioning plan for a corroboration-grid witness of a given plane (CODESPACE|VBOX|WIN). Live execution is the operator step.', inputSchema: { type: 'object', properties: { plane: { type: 'string', enum: ['CODESPACE', 'VBOX', 'WIN'] } }, required: ['plane'], additionalProperties: false } },
  { name: 'run_quorum', description: 'Run the corroboration quorum (ADR-0015) over a set of witness bundles and return the graded-majority verdict.', inputSchema: { type: 'object', properties: { bundles: { type: 'array' }, threshold: { type: 'number' } }, required: ['bundles'], additionalProperties: false } },
  { name: 'get_confidence', description: 'Return just the quorum verdict + graded confidence for a set of witness bundles.', inputSchema: { type: 'object', properties: { bundles: { type: 'array' }, threshold: { type: 'number' } }, required: ['bundles'], additionalProperties: false } },
  { name: 'verify_attestation', description: 'Verify-before-consume (ADR-0016): given attested witnesses + an enrolled allowlist, decide whether the release is consumable.', inputSchema: { type: 'object', properties: { witnesses: { type: 'array' }, allowlist: { type: 'object' } }, required: ['witnesses'], additionalProperties: false } },
  { name: 'check_independence', description: 'Assess witness independence (ADR-0017): whether the witnesses span distinct enrolled environments with recorded identities.', inputSchema: { type: 'object', properties: { witnesses: { type: 'array' }, enrollment: { type: 'object' } }, required: ['witnesses'], additionalProperties: false } },
  { name: 'assemble_witness', description: 'Assemble a witness bundle (ADR-0014) from its gate/screenshot/capability receipts, failing closed on a missing anchor.', inputSchema: { type: 'object', properties: { plane: { type: 'string' }, gate: { type: 'object' }, screenshot: { type: 'object' }, capability: { type: 'object' }, os: { type: 'string' }, ubuntu: { type: 'string' } }, required: ['plane', 'gate', 'screenshot'], additionalProperties: false } },
  { name: 'teardown', description: 'Return the teardown plan for a corroboration-grid witness of a given plane. Live execution is the operator step.', inputSchema: { type: 'object', properties: { plane: { type: 'string', enum: ['CODESPACE', 'VBOX', 'WIN'] }, id: { type: 'string' } }, required: ['plane'], additionalProperties: false } },
];

const KNOWN_TOOL_NAMES = new Set(ACG_GRID_TOOLS.map((t) => t.name));

// Run a grid tool by name (throws McpArgumentError on a bad argument shape). Reused by the MCP handler + callers.
export function dispatchGridTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new McpArgumentError(`unknown tool: ${name}`);
  return handler(args ?? {});
}

const success = (id, result) => ({ jsonrpc: '2.0', id, result });
const failure = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// Dependency-free JSON-RPC 2.0 dispatcher for the ACG grid MCP surface (mirrors handleBenchmarkActorMcpMessage).
// Returns a response for requests, or null for notifications. Argument failures -> -32602; tool-execution failures
// stay inside the result envelope (isError:true) per MCP so the agent can read the message.
export function handleAcgGridMcpMessage(message, { serverVersion = '0.0.0' } = {}) {
  const id = message?.id ?? null;
  switch (message?.method) {
    case 'initialize':
      return success(id, { protocolVersion: ACG_GRID_MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: ACG_GRID_MCP_SERVER_NAME, version: serverVersion } });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return success(id, {});
    case 'tools/list':
      return success(id, { tools: ACG_GRID_TOOLS });
    case 'tools/call': {
      const params = message.params ?? {};
      if (typeof params.name !== 'string') return failure(id, JSON_RPC_INVALID_PARAMS, 'tools/call requires a string "name"');
      if (!KNOWN_TOOL_NAMES.has(params.name)) return failure(id, JSON_RPC_INVALID_PARAMS, `unknown tool: ${params.name}`);
      try {
        const result = dispatchGridTool(params.name, params.arguments);
        return success(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (error) {
        if (error instanceof McpArgumentError) return failure(id, JSON_RPC_INVALID_PARAMS, error.message);
        // A genuine tool-execution failure (e.g. assemble fails closed) rides inside the result envelope per MCP.
        return success(id, { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true });
      }
    }
    default:
      return failure(id, JSON_RPC_METHOD_NOT_FOUND, `unknown method: ${message?.method}`);
  }
}
