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

// A genuine tool-execution fault (a dep that THROWS a non-argument error) is NOT masked as -32602: it
// propagates out of the handler so the transport layer logs it, rather than being silently swallowed.
const throwingDeps = { ...deps, getHostCapabilities: async () => { throw new Error('tool exploded'); } };
let rethrew = null;
try {
  await core.handleBenchmarkActorMcpMessage({ id: 60, method: 'tools/call', params: { name: 'get_host_capabilities' } }, throwingDeps);
} catch (e) {
  rethrew = e;
}
assert(rethrew instanceof Error && /tool exploded/.test(rethrew.message), 'a non-argument tool failure propagates (rethrown), not masked as an invalid-params error');

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

// parseTail / parseMessage boundary branches (all via the fake deps; -32602 short-circuits before any dep runs).
const tailNonObj = await core.handleBenchmarkActorMcpMessage({ id: 14, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: 'nope' } }, deps);
assert(tailNonObj.error && tailNonObj.error.code === -32602, 'poll with non-object arguments -> -32602');
const tailAbsentKey = await core.handleBenchmarkActorMcpMessage({ id: 15, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { other: 1 } } }, deps);
assert(tailAbsentKey.result.content[0].text === 'poll tail=10', 'poll with an object lacking a tail key defaults tail to 10');
const tailFloat = await core.handleBenchmarkActorMcpMessage({ id: 16, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { tail: 2.5 } } }, deps);
assert(tailFloat.error && tailFloat.error.code === -32602, 'poll with a non-integer tail -> -32602');
const tailLow = await core.handleBenchmarkActorMcpMessage({ id: 17, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { tail: 0 } } }, deps);
assert(tailLow.error && tailLow.error.code === -32602, 'poll with tail below 1 -> -32602');
const msgNonObj = await core.handleBenchmarkActorMcpMessage({ id: 18, method: 'tools/call', params: { name: 'post_coordination_note', arguments: 'hi' } }, deps);
assert(msgNonObj.error && msgNonObj.error.code === -32602, 'post with non-object arguments -> -32602');
const msgBlank = await core.handleBenchmarkActorMcpMessage({ id: 19, method: 'tools/call', params: { name: 'post_coordination_note', arguments: { message: '   ' } } }, deps);
assert(msgBlank.error && msgBlank.error.code === -32602, 'post with a blank (whitespace-only) message -> -32602');

// Folded EXTRA tools: the ACG corroboration-grid surface is injected at runtime; a mock here proves the pure
// handler PUBLISHES the injected tools in tools/list, ROUTES a call to dispatchExtraTool and wraps its result,
// maps a folded-tool argument error to -32602, and rides a genuine folded-tool failure in the isError envelope.
const extraTool = { name: 'demo_grid_tool', description: 'demo', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const extraDeps = {
  ...deps,
  extraTools: [extraTool],
  dispatchExtraTool: (name, args) => {
    if (args && args.bad) { throw new core.McpArgumentError('bad demo arg'); }
    if (args && args.boom) { throw new Error('grid tool exploded'); }
    return { ok: true, echo: args ?? null };
  },
};
const extraList = await core.handleBenchmarkActorMcpMessage({ id: 20, method: 'tools/list' }, extraDeps);
assert(extraList.result.tools.length === 5 && extraList.result.tools.some((t) => t.name === 'demo_grid_tool'), 'tools/list folds injected extra tools alongside the 4 core tools');
const extraCall = await core.handleBenchmarkActorMcpMessage({ id: 21, method: 'tools/call', params: { name: 'demo_grid_tool', arguments: { x: 1 } } }, extraDeps);
assert(JSON.parse(extraCall.result.content[0].text).ok === true, 'tools/call routes a folded tool to dispatchExtraTool and wraps its plain result');
const extraBad = await core.handleBenchmarkActorMcpMessage({ id: 22, method: 'tools/call', params: { name: 'demo_grid_tool', arguments: { bad: true } } }, extraDeps);
assert(extraBad.error && extraBad.error.code === -32602, 'a folded-tool argument error -> -32602');
const extraBoom = await core.handleBenchmarkActorMcpMessage({ id: 23, method: 'tools/call', params: { name: 'demo_grid_tool', arguments: { boom: true } } }, extraDeps);
assert(extraBoom.result && extraBoom.result.isError === true, 'a folded-tool execution failure rides isError in the result envelope');

// loadAcgGridTools folds the REAL bundled grid tools (out/acg-mcp-bundle/) into a deps object, and degrades
// quietly when the bundle is absent -- exercised in-process for determinism + coverage of the runtime loader.
const runner = require(serverPath);
const gridDeps = { ...deps };
await runner.loadAcgGridTools(gridDeps, root);
assert(
  Array.isArray(gridDeps.extraTools) && gridDeps.extraTools.length === 9 && typeof gridDeps.dispatchExtraTool === 'function',
  'loadAcgGridTools folds the 9 ACG grid tools into the server deps from the staged bundle'
);
const gridList = await core.handleBenchmarkActorMcpMessage({ id: 30, method: 'tools/list' }, gridDeps);
assert(gridList.result.tools.length === 13, 'the folded deps publish all 13 tools (4 core + 9 grid)');
const gridOk = await core.handleBenchmarkActorMcpMessage({ id: 31, method: 'tools/call', params: { name: 'spin_up_witness', arguments: { plane: 'WIN' } } }, gridDeps);
assert(JSON.parse(gridOk.result.content[0].text).plane === 'WIN', 'a folded grid tool executes via the loaded deps');
const gridBad = await core.handleBenchmarkActorMcpMessage({ id: 32, method: 'tools/call', params: { name: 'run_quorum', arguments: {} } }, gridDeps);
assert(gridBad.error && gridBad.error.code === -32602, "a folded grid tool's argument error is bridged to -32602");
const degradeDeps = { ...deps };
await runner.loadAcgGridTools(degradeDeps, join(root, 'no-such-acg-bundle-root-xyz'));
assert(degradeDeps.extraTools === undefined, 'loadAcgGridTools degrades quietly (no extra tools) when the bundle is absent');
console.log('mcp-core: PASS -- protocol dispatch + 4 tools + folded extra-tool routing + -32601/-32602 error codes');

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
  workspace: { registerTextDocumentContentProvider: () => ({ dispose() {} }), workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }) },
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

// provider field-builder + registration fallback branches (module is cached with the mock vscode binding).
const providerMod = require(join(root, 'out', 'mcp', 'benchmarkActorMcpServerProvider.js'));
const fExplicit = providerMod.buildBenchmarkActorMcpServerDefinitionFields({ extensionPath: '/x', execPath: '/node', scriptPath: '/explicit/server.js' });
assert(fExplicit.args[0] === '/explicit/server.js' && fExplicit.version === undefined, 'buildFields honors an explicit scriptPath and an absent version');
// LBA-REQ-062 (off-Discussions step 3): busEnvFromConfig maps the transport config to the MCP server's env.
const envNet = providerMod.busEnvFromConfig({ transport: 'net', netHosts: '10.0.2.2', netLog: '/tmp/bus.jsonl' });
assert(envNet.VIHS_COLLAB_TRANSPORT === 'net' && envNet.VIHS_COLLAB_NET_HOSTS === '10.0.2.2' && envNet.VIHS_COLLAB_NET_LOG === '/tmp/bus.jsonl', 'busEnvFromConfig maps net transport + hosts + log to env');
const envDisc = providerMod.busEnvFromConfig({ transport: 'discussion', netHosts: '', netLog: '' });
assert(Object.keys(envDisc).length === 0, 'busEnvFromConfig yields no env for the Discussion default');
const fDefault = providerMod.buildBenchmarkActorMcpServerDefinitionFields({ extensionPath: '/x', execPath: '/node', version: '1.2.3' });
assert(fDefault.args[0] === providerMod.resolveBenchmarkActorMcpServerScriptPath('/x') && fDefault.version === '1.2.3', 'buildFields resolves the default script path + carries the version');
const capturedDirect = [];
mockVscode.lm.registerMcpServerDefinitionProvider = (id, provider) => { capturedDirect.push({ id, provider }); return { dispose() {} }; };
const dispFallback = providerMod.registerBenchmarkActorMcpServerProvider({ subscriptions: [], extensionUri: { fsPath: '/via-uri' } });
assert(dispFallback && capturedDirect.length === 1, 'registerProvider without extensionPath falls back to extensionUri.fsPath and registers');
assert(/via-uri[\\/]+out[\\/]+mcp/.test(capturedDirect[0].provider.provideMcpServerDefinitions()[0].args[0]), 'the fallback definition resolves the script under the extensionUri fsPath');
mockVscode.lm.registerMcpServerDefinitionProvider = undefined; // simulate a host predating the MCP API
const noop = providerMod.registerBenchmarkActorMcpServerProvider({ subscriptions: [] });
assert(noop === undefined, 'registerProvider is a no-op (undefined) when the host lacks the MCP definition-provider API');

console.log('mcp-activation: PASS -- provider registered, manifest id == runtime id, bundled stdio launch');

// ---- 3. STDIO: real newline-delimited JSON-RPC round-trip against the spawned server ----
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const got = new Map();
  let parseErr = null;
  const want = [1, 2, 3, 4, 5, 6];
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
      const stdioTools = got.get(2).result.tools.map((t) => t.name);
      assert(stdioTools.length === 13, '[stdio] tools/list folds the 4 core + 9 ACG grid tools (13 total)');
      for (const g of ['run_quorum', 'verify_attestation', 'verify_inclusion', 'verify_before_install', 'spin_up_witness']) {
        assert(stdioTools.includes(g), `[stdio] tools/list includes the folded grid tool ${g}`);
      }
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
      const grid6 = JSON.parse(got.get(6).result.content[0].text);
      assert(grid6.executed === false && /gh codespace create/.test(grid6.command), '[stdio] a folded grid tool (spin_up_witness) executes in the single shipped server binary');
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
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'spin_up_witness', arguments: { plane: 'CODESPACE' } } });
});
console.log('mcp-stdio: PASS -- spawned server round-trips initialize + tools/list + tools/call over stdio');

// ---- 3b. STDIO lifecycle: the poll + post coordination-bus tools exercise the runLbabus arrows, and a FINAL
//          line WITHOUT a trailing newline proves the stream-end leftover-buffer flush. lbabus is deliberately
//          off-PATH so `post` degrades to a soft ENOENT and NEVER writes to the live coordination bus. ----
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: '/nonexistent-lba-path' }
  });
  let buf = '';
  let ended = false;
  const got = new Map();
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('stdio lifecycle timed out'));
  }, 15000);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        const m = JSON.parse(line);
        if (m.id !== undefined && m.id !== null) got.set(m.id, m);
      }
      i = buf.indexOf('\n');
    }
    if (got.has(20) && got.has(21) && !ended) {
      // poll(20) + post(21) answered; end the stream to flush the trailing no-newline line 22.
      ended = true;
      child.stdin.end();
      return;
    }
    if (!got.has(22)) return;
    clearTimeout(timer);
    try {
      assert(
        got.get(20).result && Array.isArray(got.get(20).result.content),
        '[stdio-life] poll_coordination_bus returns a content result (runLbabus soft ENOENT off-PATH)'
      );
      assert(
        got.get(21).result && Array.isArray(got.get(21).result.content),
        '[stdio-life] post_coordination_note returns a content result (soft ENOENT -- never touches the live bus)'
      );
      assert(
        got.get(22).result && got.get(22).result.protocolVersion === '2025-06-18',
        '[stdio-life] a final line WITHOUT a trailing newline is still dispatched on stream end (leftover-buffer flush)'
      );
    } catch (e) {
      child.kill();
      reject(e);
      return;
    }
    child.on('close', () => resolve());
  });
  child.stderr.on('data', () => {}); // ready banner + diagnostics; ignore
  child.on('error', reject);

  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 20, method: 'tools/call', params: { name: 'poll_coordination_bus', arguments: { tail: 3 } } });
  send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'post_coordination_note', arguments: { message: 'lifecycle probe (off-PATH, discarded)' } } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'initialize' })); // NO trailing newline -> flushed on end
});
console.log('mcp-stdio-life: PASS -- poll/post coordination-bus arrows + stream-end leftover-buffer flush');

// ---- 3c. CORRUPT/RELOCATED install fault paths, unit-driven in-process on the REAL entrypoint module so the
//          graceful-degradation branches are proven (and instrumented): a missing package.json makes
//          readServerVersion fall back to 'unknown', and a missing bundled series makes getBenchmarkSeries a
//          soft isError. errorText folds non-Error throwables to a string. ----
const server = require(serverPath);
assert(
  server.readServerVersion('/nonexistent-lba-root') === 'unknown',
  'readServerVersion falls back to "unknown" when package.json is unreadable'
);
assert(server.readServerVersion().length > 0, 'readServerVersion reads the real bundled version by default');
const seriesFault = await server.getBenchmarkSeries('/nonexistent-lba-root');
assert(
  seriesFault.isError === true && /unavailable/i.test(seriesFault.content[0].text),
  `getBenchmarkSeries degrades to a soft isError when the bundled series is missing, got: ${JSON.stringify(seriesFault)}`
);
const seriesOk = await server.getBenchmarkSeries();
assert(!seriesOk.isError && /benchmark-series@v1/.test(seriesOk.content[0].text), 'getBenchmarkSeries reads the real bundled series by default');
assert(server.errorText('a bare string') === 'a bare string', 'errorText passes a non-Error throwable through as a string');
assert(server.errorText(new Error('boom')) === 'boom', 'errorText unwraps an Error to its message');
console.log('mcp-stdio-corrupt: PASS -- version=unknown fallback + soft series isError + errorText folding (graceful)');

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
