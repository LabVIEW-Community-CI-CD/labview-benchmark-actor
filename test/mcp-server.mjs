#!/usr/bin/env node
// Maintainer test for the labview-benchmark-actor MCP surface. Three legs, all deterministic and
// host-free (no real VS Code, no display, no `lbabus` needed):
//   1. PURE CORE   -- drive the compiled JSON-RPC handler with injected tool deps: initialize, tools/list,
//                     tools/call routing, and the -32601/-32602 error codes.
//   2. ACTIVATION  -- mock `vscode` (incl. the 1.101 `lm` MCP API) and assert activate() registers the MCP
//                     provider with the SAME id the manifest contributes, launching the bundled stdio entry.
//   3. STDIO       -- spawn the real server entrypoint and round-trip initialize + tools/list + tools/call
//                     (get_benchmark_series is deterministic and needs no CLI) over newline-delimited JSON-RPC.
// Run after `npm run compile`. Usage: node test/mcp-server.mjs
import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const root = join(here, '..');

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
}

const corePath = join(root, 'out', 'mcp', 'benchmarkActorMcpServer.js');
const extPath = join(root, 'out', 'extension.js');
const serverPath = join(root, 'out', 'mcp', 'runBenchmarkActorMcpServer.js');
for (const p of [corePath, extPath, serverPath]) {
  assert(existsSync(p), `${p} not found -- run \`npm run compile\` first.`);
}

// ---- 1. PURE CORE: protocol dispatch with injected tool implementations ----
const core = require(corePath);
const fakeResult = (text) => ({ content: [{ type: 'text', text }] });
const deps = {
  serverVersion: '9.9.9',
  getHostCapabilities: async () => fakeResult('caps'),
  getBenchmarkSeries: async () => fakeResult('{"points":3}'),
  pollCoordinationBus: async ({ tail }) => fakeResult(`poll tail=${tail}`),
  postCoordinationNote: async ({ message }) => fakeResult(`posted ${message}`),
};

const init = await core.handleBenchmarkActorMcpMessage({ id: 1, method: 'initialize' }, deps);
assert(init.result.protocolVersion === '2025-06-18', 'initialize returns protocol 2025-06-18');
assert(
  init.result.serverInfo.name === 'labview-benchmark-actor' && init.result.serverInfo.version === '9.9.9',
  'initialize serverInfo carries the server name + the injected version'
);
assert(init.result.capabilities && init.result.capabilities.tools, 'initialize advertises the tools capability');

const listed = await core.handleBenchmarkActorMcpMessage({ id: 2, method: 'tools/list' }, deps);
const names = listed.result.tools.map((t) => t.name);
assert(names.length === 4, 'tools/list publishes 4 tools');
for (const n of ['get_host_capabilities', 'get_benchmark_series', 'poll_coordination_bus', 'post_coordination_note']) {
  assert(names.includes(n), `tools/list includes ${n}`);
}
for (const t of listed.result.tools) {
  assert(
    typeof t.description === 'string' && t.description.length > 0 && t.inputSchema && t.inputSchema.type === 'object',
    `tool ${t.name} has a description + an object inputSchema`
  );
}

const notif = await core.handleBenchmarkActorMcpMessage({ method: 'notifications/initialized' }, deps);
assert(notif === null, 'notifications get no response');

const callOk = await core.handleBenchmarkActorMcpMessage(
  { id: 3, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { tail: 5 } } },
  deps
);
assert(callOk.result.content[0].text === 'poll tail=5', 'tools/call routes validated args to the tool');

const unknownTool = await core.handleBenchmarkActorMcpMessage(
  { id: 4, method: 'tools/call', params: { name: 'nope' } },
  deps
);
assert(unknownTool.error && unknownTool.error.code === -32602, 'unknown tool -> -32602 invalid params');

const badArg = await core.handleBenchmarkActorMcpMessage(
  { id: 5, method: 'tools/call', params: { name: 'post_coordination_note', arguments: {} } },
  deps
);
assert(badArg.error && badArg.error.code === -32602, 'missing required arg -> -32602 invalid params');

const unknownMethod = await core.handleBenchmarkActorMcpMessage({ id: 6, method: 'foo/bar' }, deps);
assert(unknownMethod.error && unknownMethod.error.code === -32601, 'unknown method -> -32601 method not found');

// Remaining handler branches, all via the INJECTED fake deps (deterministic, no real CLI, no side effects):
const ping = await core.handleBenchmarkActorMcpMessage({ id: 7, method: 'ping' }, deps);
assert(ping.result && typeof ping.result === 'object', 'ping -> empty success result');
const cancelled = await core.handleBenchmarkActorMcpMessage({ method: 'notifications/cancelled' }, deps);
assert(cancelled === null, 'notifications/cancelled gets no response');
const noName = await core.handleBenchmarkActorMcpMessage({ id: 8, method: 'tools/call', params: { name: 123 } }, deps);
assert(noName.error && noName.error.code === -32602, 'tools/call with a non-string name -> -32602');
const pollDefault = await core.handleBenchmarkActorMcpMessage(
  { id: 9, method: 'tools/call', params: { name: 'poll_coordination_bus' } },
  deps
);
assert(pollDefault.result.content[0].text === 'poll tail=10', 'poll_coordination_bus without args defaults tail to 10');
const badTail = await core.handleBenchmarkActorMcpMessage(
  { id: 10, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { tail: 999 } } },
  deps
);
assert(badTail.error && badTail.error.code === -32602, 'poll_coordination_bus with an out-of-range tail -> -32602');
const caps = await core.handleBenchmarkActorMcpMessage(
  { id: 11, method: 'tools/call', params: { name: 'get_host_capabilities' } },
  deps
);
assert(caps.result.content[0].text === 'caps', 'get_host_capabilities routes to the injected dep');
const series = await core.handleBenchmarkActorMcpMessage(
  { id: 12, method: 'tools/call', params: { name: 'get_benchmark_series' } },
  deps
);
assert(series.result.content[0].text === '{"points":3}', 'get_benchmark_series routes to the injected dep');
const posted = await core.handleBenchmarkActorMcpMessage(
  { id: 13, method: 'tools/call', params: { name: 'post_coordination_note', arguments: { message: 'hi' } } },
  deps
);
assert(posted.result.content[0].text === 'posted hi', 'post_coordination_note routes a validated message to the injected dep');
console.log('mcp-core: PASS -- protocol dispatch + 4 tools + -32601/-32602 error codes');

// ---- 2. ACTIVATION: the extension registers the MCP provider (manifest id == runtime id) ----
const captured = [];
class McpStdioServerDefinition {
  constructor(label, command, args, env, version) {
    Object.assign(this, { label, command, args, env, version });
  }
}
const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInputBox: async () => undefined,
    showErrorMessage: () => undefined,
  },
  ViewColumn: { Active: -1 },
  Uri: {
    joinPath: (b, ...p) => ({ path: [b && b.path ? b.path : '', ...p].join('/') }),
    parse: (s) => ({ toString: () => s, path: s, scheme: String(s).split(':')[0] }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined },
  workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), workspaceFolders: [] },
  languages: { setTextDocumentLanguage: async (d) => d },
  lm: {
    registerMcpServerDefinitionProvider: (id, provider) => {
      captured.push({ id, provider });
      return { dispose() {} };
    },
  },
  McpStdioServerDefinition,
};
const childProcessMock = {
  execFile: (_f, _a, ob, mc) => {
    const cb = typeof ob === 'function' ? ob : mc;
    cb(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  },
};
const originalLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') return mockVscode;
  if (request === 'node:child_process' || request === 'child_process') return childProcessMock;
  return originalLoad.call(this, request, parent, isMain);
};

const ext = require(extPath);
const subscriptions = [];
ext.activate({
  subscriptions,
  extensionPath: '/ext',
  extensionUri: { path: '/ext', fsPath: '/ext' },
  extension: { packageJSON: { version: '0.1.1' } },
});
Module._load = originalLoad;

assert(captured.length === 1, 'activate() registers exactly one MCP server definition provider');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifestId = manifest.contributes.mcpServerDefinitionProviders[0].id;
assert(
  captured[0].id === manifestId,
  `runtime provider id (${captured[0].id}) must match the manifest contribution id (${manifestId})`
);
const defs = captured[0].provider.provideMcpServerDefinitions();
assert(Array.isArray(defs) && defs.length === 1, 'the provider yields exactly one server definition');
assert(defs[0].command === process.execPath, 'the server launches with the editor Node (process.execPath)');
assert(
  /out[\\/]+mcp[\\/]+runBenchmarkActorMcpServer\.js$/.test(defs[0].args[0]),
  'the server arg is the bundled stdio entrypoint (out/mcp/runBenchmarkActorMcpServer.js)'
);
console.log('mcp-activation: PASS -- provider registered, manifest id == runtime id, bundled stdio launch');

// ---- 3. STDIO: real newline-delimited JSON-RPC round-trip against the spawned server ----
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const got = new Map();
  let parseErr = null;
  const want = [1, 2, 3, 4, 5];
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('stdio round-trip timed out'));
  }, 15000);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && msg.id !== null) got.set(msg.id, msg);
        else if (msg.error && msg.error.code === -32700) parseErr = msg;
      }
      i = buf.indexOf('\n');
    }
    if (!want.every((id) => got.has(id))) return;
    clearTimeout(timer);
    try {
      assert(got.get(1).result.protocolVersion === '2025-06-18', '[stdio] initialize protocol version');
      assert(got.get(1).result.serverInfo.name === 'labview-benchmark-actor', '[stdio] initialize serverInfo name');
      assert(got.get(2).result.tools.length === 4, '[stdio] tools/list returns 4 tools');
      const env = JSON.parse(got.get(3).result.content[0].text);
      assert(
        env.schema === 'labview-benchmark-actor/benchmark-series@v1' &&
          typeof env.seriesHash === 'string' &&
          Array.isArray(env.series),
        '[stdio] get_benchmark_series returns the deterministic hashed series envelope'
      );
      assert(got.get(4).error && got.get(4).error.code === -32602, '[stdio] unknown tool -> -32602');
      assert(
        got.get(5).result && got.get(5).result.content && typeof got.get(5).result.content[0].text === 'string',
        '[stdio] get_host_capabilities returns a content result (runLbabus success or a soft ENOENT isError)'
      );
      assert(parseErr && parseErr.error.code === -32700, '[stdio] a malformed line yields a -32700 parse error (id null)');
    } catch (e) {
      child.kill();
      reject(e);
      return;
    }
    child.stdin.end();
    child.on('close', () => resolve());
  });
  child.stderr.on('data', () => {}); // ready banner + diagnostics; ignore
  child.on('error', reject);

  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_benchmark_series' } });
  send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } });
  child.stdin.write('this is not valid json\n');
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_host_capabilities' } });
});
console.log('mcp-stdio: PASS -- spawned server round-trips initialize + tools/list + tools/call over stdio');

// ---- 4. STDIO with lbabus ABSENT (broken PATH): get_host_capabilities degrades to a SOFT ENOENT isError,
//         not a transport crash -- the graceful-degradation path for an agent on a host without lbabus. ----
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: '/nonexistent-lba-path' },
  });
  let buf = '';
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('stdio ENOENT round-trip timed out'));
  }, 15000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== 7) continue;
      clearTimeout(timer);
      try {
        assert(msg.result && msg.result.isError === true, '[stdio-noenv] lbabus-absent get_host_capabilities is a soft isError, not a crash');
        assert(/not on PATH|lbabus/i.test(msg.result.content[0].text), `[stdio-noenv] the soft error names the missing lbabus CLI, got: ${msg.result.content[0].text}`);
      } catch (e) {
        child.kill();
        reject(e);
        return;
      }
      child.stdin.end();
      child.on('close', () => resolve());
    }
  });
  child.stderr.on('data', () => {}); // ready banner + diagnostics; ignore
  child.on('error', reject);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'initialize' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_host_capabilities' } })}\n`);
});
console.log('mcp-stdio-noenv: PASS -- lbabus-absent host capabilities degrades to a soft isError (no crash)');
console.log('mcp-server: PASS');
