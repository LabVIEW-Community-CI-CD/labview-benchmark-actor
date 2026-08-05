#!/usr/bin/env node
// Maintainer activation test for the labview-benchmark-actor extension (LBA-REQ-001): mock the `vscode`
// module, load the COMPILED extension, and assert activate() registers its full command surface and that
// deactivate() is callable -- proving the extension activates without a real VS Code host or a display.
// Run after `npm run compile` (needs out/extension.js). A re-runnable proof; the full install-activation on
// a published .vsix (Codespace / golden VM) is the maintainer step.
//
// Usage: npm test   (== npm run compile && node test/extension-activation.mjs)

import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const require = createRequire(import.meta.url);
// Cross-platform temp roots (never rely on a literal POSIX /tmp -- these tests also run on windows-latest CI):
// a (real) global-storage root the correlator fixture is written under, plus two guaranteed-nonexistent roots
// used to prove graceful degradation on a corrupt/missing install.
const gsRoot = join(tmpdir(), 'lba-test-globalstorage-nonexistent-xyz');
const brokenExtRoot = join(tmpdir(), 'lba-nonexistent-ext-xyz');
const brokenGsRoot = join(tmpdir(), 'lba-nonexistent-gs2-xyz');

const compiled = join(here, '..', 'out', 'extension.js');
if (!existsSync(compiled)) {
  console.error('out/extension.js not found -- run `npm run compile` first.');
  process.exit(1);
}

// Mock the `vscode` module (host-provided at runtime; unavailable in plain node).
const registered = [];
const registeredTools = [];
const panels = [];
const errorMessages = [];
const infoMessages = [];
const infoResponseQueue = [];
const executedCommands = [];
const warnMessages = [];
const warnResponseQueue = [];
const sentCommands = [];
const inputQueue = [];
const errorResponseQueue = [];
const openedExternal = [];
const configStore = {};
let agentsContentProvider = null;
const mockVscode = {
  window: {
    createOutputChannel: () => ({ append() {}, appendLine() {}, show() {}, dispose() {} }),
    showInputBox: async (options) => {
      const value = inputQueue.shift();
      if (options && typeof options.validateInput === 'function' && value !== undefined) {
        const validationError = options.validateInput(value);
        if (validationError) {
          return undefined; // invalid input -> VS Code blocks OK; simulate the user cancelling
        }
      }
      return value;
    },
    showInformationMessage: (message) => {
      infoMessages.push(message);
      return Promise.resolve(infoResponseQueue.length ? infoResponseQueue.shift() : undefined);
    },
    withProgress: async (_options, task) => task({ report() {} }),
    showWarningMessage: (message) => {
      warnMessages.push(message);
      return warnResponseQueue.length ? warnResponseQueue.shift() : undefined;
    },
    showTextDocument: async () => undefined,
    createTerminal: (options) => ({
      name: options && options.name,
      show() {},
      sendText: (command) => { sentCommands.push(command); },
    }),
    showErrorMessage: (message) => {
      errorMessages.push(message);
      return Promise.resolve(errorResponseQueue.length ? errorResponseQueue.shift() : undefined);
    },
    createWebviewPanel: (viewType, title) => {
      const panel = {
        viewType,
        title,
        webview: {
          _html: '',
          _msgHandler: null,
          asWebviewUri: (u) => ({ toString: () => `vscode-resource://${u && u.path ? u.path : u}` }),
          cspSource: 'vscode-webview:',
          onDidReceiveMessage(handler, _thisArg, disposables) {
            this._msgHandler = handler;
            const d = { dispose() {} };
            if (Array.isArray(disposables)) { disposables.push(d); }
            return d;
          },
          set html(v) {
            this._html = v;
          },
          get html() {
            return this._html;
          },
        },
      };
      panels.push(panel);
      return panel;
    },
  },
  ViewColumn: { Active: -1 },
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
  Uri: {
    joinPath: (base, ...parts) => {
      const joined = [base && (base.fsPath || base.path) ? (base.fsPath || base.path) : '', ...parts].join('/');
      return { path: joined, fsPath: joined, toString: () => joined };
    },
    parse: (s) => ({ toString: () => s, path: s, scheme: String(s).split(':')[0] }),
    file: (p) => ({ path: p, fsPath: p, scheme: 'file', toString: () => p }),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.push({ id, handler });
      return { dispose() {} };
    },
    executeCommand: async (id) => { executedCommands.push(id); return undefined; },
  },
  env: {
    openExternal: (uri) => { openedExternal.push(uri && uri.toString ? uri.toString() : String(uri)); return Promise.resolve(true); },
  },
  workspace: {
    registerTextDocumentContentProvider: (_scheme, provider) => {
      agentsContentProvider = provider;
      return { dispose() {} };
    },
    getConfiguration: () => ({ get: (key, dflt) => (Object.prototype.hasOwnProperty.call(configStore, key) ? configStore[key] : dflt) }),
    workspaceFolders: [{ uri: { path: repoRoot, fsPath: repoRoot } }],
    fs: {
      stat: async (uri) => {
        const p = (uri && (uri.fsPath || uri.path)) || '';
        if (!existsSync(p)) {
          throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
        }
        return { type: 1, size: statSync(p).size };
      },
      readFile: async (uri) => readFileSync((uri && (uri.fsPath || uri.path)) || ''),
      writeFile: async (uri, content) => {
        writeFileSync((uri && (uri.fsPath || uri.path)) || '', content);
      },
    },
    openTextDocument: async () => ({}),
  },
  languages: { setTextDocumentLanguage: async (doc) => doc },
  lm: {
    registerTool: (name, tool) => {
      registeredTools.push({ name, tool });
      return { dispose() {} };
    },
  },
  LanguageModelToolResult: class {
    constructor(parts) {
      this.content = parts;
    }
  },
  LanguageModelTextPart: class {
    constructor(value) {
      this.value = value;
    }
  },
};

// Mock `node:child_process` so the CLI-backed commands exercise the prerequisite-absent branch
// deterministically -- execFile always fails with ENOENT (as if `lbabus` is not installed), regardless
// of whether the coordination CLI happens to be on the test host's PATH.
// captureLaunchMprr spawns a real `node` run of the mprr runner; this mock lets the test drive its
// success / non-zero-exit / spawn-error branches deterministically (the test sets `spawnMode`).
let spawnMode = { code: 0 };
// spawnSync stays REAL (captured before the Module._load patch below): resolveFfmpegChecked/ffmpegRunnable probe
// `<ffmpeg> -version` to detect ENOENT, and the ffmpeg pre-flight test wants that genuine spawn behaviour.
const realChildProcess = require('node:child_process');
const childProcessMock = {
  spawnSync: (...args) => realChildProcess.spawnSync(...args),
  execFile: (_file, _args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    callback(Object.assign(new Error('spawn lbabus ENOENT'), { code: 'ENOENT' }));
  },
  spawn: (_file, _args, opts) => {
    const mkStream = () => ({ on(event, cb) { if (event === 'data') { cb(Buffer.from('[mprr] run\n')); } return this; } });
    const handlers = {};
    const proc = { stdout: mkStream(), stderr: mkStream(), on(event, cb) { handlers[event] = cb; return this; } };
    setImmediate(() => {
      if (spawnMode.error) { if (handlers.error) { handlers.error(new Error('spawn node ENOENT')); } return; }
      const outTrend = opts && opts.env && opts.env.LBA_OUT;
      if (spawnMode.code === 0 && outTrend) {
        writeFileSync(outTrend, JSON.stringify({ schema: 'labview-benchmark-actor/workload-trend@1', plane: 'LINUX', n: 3, verdict: 'PASS', latest: 1919, stats: { mean: 1866.3 } }));
      }
      if (handlers.close) { handlers.close(spawnMode.code); }
    });
    return proc;
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  if (request === 'node:child_process' || request === 'child_process') {
    return childProcessMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL  ${msg}`);
    process.exit(1);
  }
}

try {
  const ext = require(compiled);
  assert(typeof ext.activate === 'function', 'the extension exports activate()');
  assert(typeof ext.deactivate === 'function', 'the extension exports deactivate()');

  const subscriptions = [];
  ext.activate({ subscriptions, extensionUri: { path: repoRoot, fsPath: repoRoot }, globalStorageUri: { fsPath: gsRoot }, extension: { packageJSON: { version: '0.1.0' } } });

  const expected = [
    'labviewBenchmarkActor.showCapabilities',
    'labviewBenchmarkActor.pollBus',
    'labviewBenchmarkActor.postNote',
    'labviewBenchmarkActor.openViewer',
    'labviewBenchmarkActor.openBenchmarkRun',
    'labviewBenchmarkActor.openBenchmarkTrend',
    'labviewBenchmarkActor.openFrameCorrelator',
    'labviewBenchmarkActor.openCrossPlaneTrend',
    'labviewBenchmarkActor.openResourceProfile',
    'labviewBenchmarkActor.openCrossPlaneResource',
    'labviewBenchmarkActor.openMeshCalibration',
    'labviewBenchmarkActor.openMeshBoard',
    'labviewBenchmarkActor.writeAgents',
    'labviewBenchmarkActor.showAgents',
    'labviewBenchmarkActor.checkAgents',
  ];
  const ids = registered.map((r) => r.id);
  for (const cmd of expected) {
    assert(ids.includes(cmd), `activate() registers command ${cmd}`);
  }
  assert(
    subscriptions.length >= expected.length,
    'activate() pushes a disposable per command onto context.subscriptions'
  );
  assert(registered.every((r) => typeof r.handler === 'function'), 'each registered command has a handler');

  // Invoke openViewer -> it must build a CSP-safe webview that loads media/viewer.js + seeds the series data
  // (LBA-REQ-004). The cursor math itself is the shipped viewerCursor.mjs, proven separately by
  // verify-viewer-cursor.mjs; here we prove the extension wires a strict, nonce-scoped viewer surface.
  const openViewer = registered.find((r) => r.id === 'labviewBenchmarkActor.openViewer');
  assert(openViewer, 'openViewer command is registered');
  openViewer.handler();
  assert(panels.length === 1, 'openViewer creates exactly one webview panel');
  const html = panels[0].webview.html;
  assert(/Content-Security-Policy/.test(html), 'viewer HTML sets a Content-Security-Policy');
  assert(/default-src 'none'/.test(html), "viewer CSP is default-src 'none' (no ambient sources)");
  const nonceMatch = /script-src 'nonce-([A-Za-z0-9]{32})'/.exec(html);
  assert(nonceMatch, 'viewer CSP allows scripts only via a 32-char nonce');
  const nonce = nonceMatch[1];
  assert(
    new RegExp(`<script type="module" nonce="${nonce}" src="[^"]*viewer\\.js"`).test(html),
    'viewer HTML loads media/viewer.js as a nonce-scoped module'
  );
  assert(/id="lba-series"/.test(html) && /"t":0/.test(html), 'viewer HTML seeds the benchmark series data block');
  assert(/<svg id="chart"/.test(html), 'viewer HTML renders the chart svg surface');

  // Prerequisite-remediation (LBA-REQ-002 / T-002): invoking a CLI-backed command when the `lbabus`
  // prerequisite is absent must surface actionable remediation via showErrorMessage rather than fail
  // silently. child_process is mocked to fail with ENOENT, standing in for a missing coordination CLI.
  const showCapabilities = registered.find((r) => r.id === 'labviewBenchmarkActor.showCapabilities');
  assert(showCapabilities, 'showCapabilities command is registered');
  await showCapabilities.handler();
  assert(errorMessages.length === 1, 'a missing-CLI failure surfaces exactly one error message');
  assert(/lbabus failed/.test(errorMessages[0]), 'the remediation names the failing prerequisite CLI (lbabus)');
  assert(
    /Install the coordination CLI/.test(errorMessages[0]),
    'the remediation tells the operator to install the coordination CLI'
  );

  // Create Cleanroom Worker VM (LBA distributed CI): the cloner drives VBoxManage + ssh via a bash script, so
  // it is a Linux/macOS HOST tool. Prove BOTH host branches independently of the CI OS by faking
  // process.platform: on win32 it must refuse with actionable guidance and send no command; on a POSIX host it
  // resolves the cloner, exercises the input validators + safe shell-quoting, and drives an integrated terminal.
  // (Faking makes this test OS-independent -- asserting the cloner drive unconditionally failed on windows-latest.)
  const createCleanroom = registered.find((r) => r.id === 'labviewBenchmarkActor.createCleanroom');
  assert(createCleanroom, 'createCleanroom command is registered');
  const realPlatformDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const errsBefore = errorMessages.length;
    const cmdsBefore = sentCommands.length;
    await createCleanroom.handler();
    assert(
      errorMessages.slice(errsBefore).some((m) => /Linux\/macOS host tool/.test(m)),
      'createCleanroom refuses on a Windows host with Linux/macOS-host-tool guidance'
    );
    assert(sentCommands.length === cmdsBefore, 'createCleanroom sends no cloner command on a Windows host');

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    inputQueue.push('lba-cleanroom-clone-01', '2223', '7441', 'cleanroom-clone');
    await createCleanroom.handler();
    const cloneCmd = sentCommands.find((c) => /clone-cleanroom-worker\.sh/.test(c));
    assert(cloneCmd, 'createCleanroom drives the cloner script in an integrated terminal on a POSIX host');
    assert(
      /'lba-cleanroom-clone-01' '2223' '7441' 'cleanroom-clone'/.test(cloneCmd),
      'createCleanroom passes the validated, shell-quoted args (no injection)'
    );
  } finally {
    Object.defineProperty(process, 'platform', realPlatformDesc);
  }

  // Bootstrap LabVIEW Authoring Lane (Windows/ActiveX): resolves the .ps1, surfaces the Windows-only note,
  // and runs it via pwsh in a terminal.
  const bootstrapLane = registered.find((r) => r.id === 'labviewBenchmarkActor.bootstrapAuthoringLane');
  assert(bootstrapLane, 'bootstrapAuthoringLane command is registered');
  await bootstrapLane.handler();
  assert(
    sentCommands.some((c) => /pwsh -NoProfile -File .*bootstrap-authoring-lane\.ps1/.test(c)),
    'bootstrapAuthoringLane runs the ps1 via pwsh'
  );
  assert(infoMessages.some((m) => /Windows-only/.test(m)), 'bootstrapAuthoringLane surfaces the Windows-only note');

  // Actor Corroboration Grid surface (ADR-0014 / ADR-0022): runCorroborationGrid runs the end-to-end grid proof
  // and verifyReleaseProvenance runs the verify-before-install verifier, each via node in an integrated terminal.
  const runGridCmd = registered.find((r) => r.id === 'labviewBenchmarkActor.runCorroborationGrid');
  assert(runGridCmd, 'runCorroborationGrid command is registered');
  await runGridCmd.handler();
  assert(
    sentCommands.some((c) => /node .*acg-grid[/\\]grid-run-proof\.mjs/.test(c)),
    'runCorroborationGrid runs grid-run-proof.mjs via node in a terminal'
  );
  const verifyProvCmd = registered.find((r) => r.id === 'labviewBenchmarkActor.verifyReleaseProvenance');
  assert(verifyProvCmd, 'verifyReleaseProvenance command is registered');
  await verifyProvCmd.handler();
  assert(
    sentCommands.some((c) => /node .*acg-transparency[/\\]verify-release-inclusion\.mjs/.test(c)),
    'verifyReleaseProvenance runs verify-release-inclusion.mjs via node in a terminal'
  );

  // Throughput-to-Disk Ladder (benchmark-variation witness): a Linux/macOS host tool (the C# tpd + fsync). Fake
  // process.platform to prove BOTH branches -- win32 refuses + sends nothing; a POSIX host resolves run-ladder.mjs,
  // prompts for the plane + rungs, and drives node in a terminal.
  const runLadderCmd = registered.find((r) => r.id === 'labviewBenchmarkActor.runThroughputLadder');
  assert(runLadderCmd, 'runThroughputLadder command is registered');
  const realPlatDescLadder = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const errsBeforeLadder = errorMessages.length;
    const cmdsBeforeLadder = sentCommands.length;
    await runLadderCmd.handler();
    assert(errorMessages.slice(errsBeforeLadder).some((m) => /Linux\/macOS tool/.test(m)), 'runThroughputLadder refuses on a Windows host');
    assert(sentCommands.length === cmdsBeforeLadder, 'runThroughputLadder sends no command on a Windows host');

    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    inputQueue.push('TEST-PLANE', '256M,512M');
    await runLadderCmd.handler();
    const ladderCmd = sentCommands.find((c) => /node .*throughput-to-disk[/\\]run-ladder\.mjs/.test(c));
    assert(ladderCmd, 'runThroughputLadder drives run-ladder.mjs via node in a terminal on a POSIX host');
    assert(/--plane "TEST-PLANE"/.test(ladderCmd) && /--rungs "256M,512M"/.test(ladderCmd), 'runThroughputLadder passes the validated plane + rungs');
  } finally {
    Object.defineProperty(process, 'platform', realPlatDescLadder);
  }

  // Agent instructions commands (issue #98): the extension bundles media/AGENTS.md + manifest and
  // materializes/verifies a workspace AGENTS.md. These are pure read/hash/compare/write flows (no cleanroom).
  // Drive them against a REAL temp workspace so the write / exists-overwrite / match / drift branches all run.
  {
    const agentsCmd = (id) => registered.find((r) => r.id === `labviewBenchmarkActor.${id}`).handler;
    const agentsWs = join(tmpdir(), 'lba-test-agents-ws-xyz');
    rmSync(agentsWs, { recursive: true, force: true });
    mkdirSync(agentsWs, { recursive: true });
    const savedFolders = mockVscode.workspace.workspaceFolders;
    mockVscode.workspace.workspaceFolders = [{ uri: { path: agentsWs, fsPath: agentsWs } }];
    const writtenAgents = join(agentsWs, 'AGENTS.md');
    try {
      // showAgents: opens the shipped canonical (stamped) as a markdown preview; also exercise the registered
      // content provider that serves it.
      await agentsCmd('showAgents')();
      assert(agentsContentProvider && typeof agentsContentProvider.provideTextDocumentContent === 'function', 'showAgents registers an AGENTS content provider');
      const served = await agentsContentProvider.provideTextDocumentContent();
      assert(/GENERATED: labview-benchmark-actor extension AGENTS\.md/.test(served), 'the content provider serves the stamped canonical AGENTS.md');

      // checkAgents on an empty workspace (folder present, no AGENTS.md yet) -> warns rather than proceeding.
      const warnBeforeAbsent = warnMessages.length;
      await agentsCmd('checkAgents')();
      assert(warnMessages.slice(warnBeforeAbsent).some((m) => /No AGENTS\.md at the workspace root/.test(m)), 'checkAgents warns when the workspace AGENTS.md is absent');

      // writeAgents on an empty workspace -> materializes AGENTS.md (no overwrite prompt).
      await agentsCmd('writeAgents')();
      assert(existsSync(writtenAgents), 'writeAgents materializes AGENTS.md at the workspace root');

      // checkAgents on the freshly-written file -> matches the shipped canonical (stamp stripped before hashing).
      const infoBeforeMatch = infoMessages.length;
      await agentsCmd('checkAgents')();
      assert(infoMessages.slice(infoBeforeMatch).some((m) => /matches the shipped/i.test(m)), 'checkAgents reports a match for the freshly-written AGENTS.md');

      // Drift: corrupt the workspace copy, then checkAgents detects drift and (Show Diff) opens vscode.diff.
      writeFileSync(writtenAgents, '# drifted agents\n');
      const execBeforeDrift = executedCommands.length;
      warnResponseQueue.push('Show Diff');
      await agentsCmd('checkAgents')();
      assert(warnMessages.some((m) => /DRIFTED/.test(m)), 'checkAgents flags a drifted AGENTS.md');
      assert(executedCommands.slice(execBeforeDrift).includes('vscode.diff'), 'checkAgents (Show Diff) opens the diff view');

      // writeAgents when the file EXISTS: overwrite prompt -> Show Diff opens the diff and returns.
      warnResponseQueue.push('Show Diff');
      await agentsCmd('writeAgents')();
      assert(executedCommands.filter((c) => c === 'vscode.diff').length >= 2, 'writeAgents (Show Diff) opens the diff view');

      // writeAgents exists -> Overwrite rewrites the canonical.
      warnResponseQueue.push('Overwrite');
      await agentsCmd('writeAgents')();
      const infoBeforeRecheck = infoMessages.length;
      await agentsCmd('checkAgents')();
      assert(infoMessages.slice(infoBeforeRecheck).some((m) => /matches the shipped/i.test(m)), 'the Overwrite-rewritten AGENTS.md matches the canonical again');
    } finally {
      mockVscode.workspace.workspaceFolders = savedFolders;
      rmSync(agentsWs, { recursive: true, force: true });
    }

    // No-folder branches: both commands warn (rather than throw) when no workspace folder is open.
    const savedFolders2 = mockVscode.workspace.workspaceFolders;
    mockVscode.workspace.workspaceFolders = undefined;
    const warnBeforeNoFolder = warnMessages.length;
    await agentsCmd('writeAgents')();
    await agentsCmd('checkAgents')();
    assert(warnMessages.length >= warnBeforeNoFolder + 2, 'writeAgents + checkAgents warn when no workspace folder is open');
    mockVscode.workspace.workspaceFolders = savedFolders2;
  }

  // Capture ASSEMBLY + CIM sampler SCRIPT: pure/file logic extracted from the cleanroom-gated ffmpeg CAPTURE, so
  // they are unit-testable directly (the ffmpeg gdigrab + PowerShell spawns that PRODUCE the frames stay live-
  // proven in the cleanroom, never faked). assembleCaptureFromDir gathers the frame PNGs + resource samples into
  // a launch-capture record; samplerScript emits the PowerShell PerformanceCounter sampler.
  {
    const capBuilder = await import(pathToFileURL(join(repoRoot, 'media', 'launch-capture.mjs')).href);
    const capDir = join(tmpdir(), 'lba-test-capture-assemble-xyz');
    rmSync(capDir, { recursive: true, force: true });
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'frame-00000.png'), 'x'.repeat(120));
    writeFileSync(join(capDir, 'frame-00001.png'), 'x'.repeat(140));
    // resources.jsonl: two valid samples (incl per-physical-disk throughput) + a blank line + a partial
    // (unparseable) line the assembler must skip.
    writeFileSync(
      join(capDir, 'resources.jsonl'),
      '{"ms":1,"cpuPct":10,"ramMb":2000,"diskPct":1,"disks":[{"name":"0 C:","writeMBs":0,"readMBs":0}]}\n\n{bad partial line\n{"ms":2,"cpuPct":12,"ramMb":2010,"diskPct":2,"disks":[{"name":"0 C:","writeMBs":11.4,"readMBs":0.2}]}\n'
    );
    const rec = ext.assembleCaptureFromDir(capDir, capBuilder);
    assert(Array.isArray(rec.frames) && rec.frames.length === 2, `assembleCaptureFromDir builds a 2-frame record, got ${rec.frames && rec.frames.length}`);
    assert(existsSync(join(capDir, 'capture.json')), 'assembleCaptureFromDir writes capture.json alongside the frames');
    assert(Array.isArray(rec.diskNames) && rec.diskNames.includes('0 C:'), 'assembleCaptureFromDir exposes the per-physical-disk names');
    assert(rec.frames[1].disks && rec.frames[1].disks[0].writeMBs === 11.4, 'assembleCaptureFromDir carries per-disk write throughput onto frames');

    // empty dir -> fails closed (no frames were captured).
    const capEmpty = join(tmpdir(), 'lba-test-capture-empty-xyz');
    rmSync(capEmpty, { recursive: true, force: true });
    mkdirSync(capEmpty, { recursive: true });
    let capThrew = false;
    try { ext.assembleCaptureFromDir(capEmpty, capBuilder); } catch { capThrew = true; }
    assert(capThrew, 'assembleCaptureFromDir throws when no frames were captured');
    rmSync(capDir, { recursive: true, force: true });
    rmSync(capEmpty, { recursive: true, force: true });

    // PerformanceCounter sampler script: CPU %, used RAM (TotalVisible - Available), disk % busy, AND
    // per-physical-disk write/read throughput; plus a single-quote-escaped out path (no injection).
    const script = ext.samplerScript("C:\\lba\\res'ources.jsonl");
    assert(
      /% Processor Time/.test(script) && /TotalVisibleMemorySize/.test(script) && /Available MBytes/.test(script) && /% Disk Time/.test(script),
      'samplerScript emits the CPU + RAM + disk% counters'
    );
    assert(
      /Disk Write Bytes\/sec/.test(script) && /Disk Read Bytes\/sec/.test(script) && /""disks""/.test(script),
      'samplerScript emits per-physical-disk read/write throughput'
    );
    assert(/res''ources\.jsonl/.test(script), 'samplerScript single-quote-escapes the out path (no injection)');
  }

  // Coverage: the staged Handoff Beacon capture-status builder (media/captureStatus.mjs is under the c8 floor)
  // exercised across every lifecycle state + defensive branch (LBA-REQ-055 / ADR-0035).
  {
    const cs = await import(pathToFileURL(join(repoRoot, 'media', 'captureStatus.mjs')).href);
    const startMs = 1_700_000_000_000;
    const rec = {
      schema: 'labview-benchmark-actor/launch-capture@1', startMs, frameCount: 4, durationMs: 250, diskNames: ['0 C:'],
      frames: [0, 1, 2, 3].map((i) => ({ index: i, tMs: Math.round((i * 1000) / 12), ms: startMs + Math.round((i * 1000) / 12) })),
    };
    const samples = [
      { ms: startMs, disks: [{ name: '0 C:', writeMBs: 0, readMBs: 0 }] },
      { ms: startMs + 100, disks: [{ name: '0 C:', writeMBs: 12, readMBs: 1 }] },
      { ms: startMs + 200, disks: [{ name: '0 C:', writeMBs: 5, readMBs: 0 }] },
      { ms: startMs + 300, disks: [{ name: '0 C:', writeMBs: 8, readMBs: 0 }, { name: '0 C:', writeMBs: null }] },
      { ms: startMs + 400 }, // no disks -> continue branch
      null,                  // null sample -> skip branch
    ];
    const capturing = cs.buildCapturingStatus({ runDir: 'C:\\run', startedAt: 'x' });
    assert(capturing.state === 'capturing' && capturing.runDir === 'C:\\run', 'capturing beacon');
    assert(cs.buildCapturingStatus({}).runDir === null, 'capturing beacon null defaults');
    const stopped = cs.buildCaptureStatus(rec, samples, { runDir: 'C:\\run', startedAt: 'a', stoppedAt: 'b' });
    assert(stopped.state === 'stopped' && stopped.wroteToDisk === true && stopped.peak.writeMBs === 12 && stopped.peak.disk === '0 C:', 'stopped beacon peak');
    assert(stopped.peak.frameIndex === 1 && stopped.perDisk[0].peakReadMBs === 1, 'stopped beacon frame + per-disk read');
    assert(cs.buildCaptureStatus(rec, samples, { writeMinSamples: 10 }).wroteToDisk === false, 'wroteToDisk threshold branch');
    assert(cs.buildCaptureStatus(rec, [{ ms: startMs, disks: [{ name: '0 C:', writeMBs: 0.5, readMBs: 0 }] }]).peak.frameIndex === 0, 'a tiny write maps the peak to the nearest frame');
    const empty = cs.buildCaptureStatus({}, []);
    assert(empty.frameCount === 0 && empty.peak.frameIndex === null && Array.isArray(empty.perDisk) && empty.perDisk.length === 0, 'empty capture defaults + null peak frame');
    const withNullDisk = cs.buildCaptureStatus(rec, [{ ms: startMs + 100, disks: [{ name: '0 C:', writeMBs: 4 }, { name: null, writeMBs: 999 }, { writeMBs: 5 }] }]);
    assert(withNullDisk.peak.writeMBs === 4 && withNullDisk.perDisk.length === 1, 'disks with a null/absent name are skipped');
    const noStartMs = cs.buildCaptureStatus({ frames: [{ index: 0, tMs: 0, ms: 5000 }, { index: 1, tMs: 83, ms: 5083 }] }, [{ ms: 5083, disks: [{ name: '0 C:', writeMBs: 9 }] }]);
    assert(noStartMs.peak.frameIndex === 1, 'startMs falls back to the first frame ms when the record omits it');
    const failed = cs.buildFailedStatus({ runDir: 'C:\\run', error: 'boom' });
    assert(failed.state === 'failed' && /boom/.test(failed.error), 'failed beacon');
    assert(cs.buildFailedStatus({}).error === 'unknown', 'failed beacon default error');
    assert(cs.validateCaptureStatus(stopped).ok && cs.validateCaptureStatus(capturing).ok && cs.validateCaptureStatus(failed).ok, 'validate admits good beacons');
    assert(!cs.validateCaptureStatus({ schema: 'nope', state: 'stopped' }).ok, 'validate rejects bad schema');
    assert(!cs.validateCaptureStatus({ schema: cs.CAPTURE_STATUS_SCHEMA, state: 'bogus' }).ok, 'validate rejects bad state');
    assert(!cs.validateCaptureStatus({ schema: cs.CAPTURE_STATUS_SCHEMA, state: 'stopped' }).ok, 'validate rejects stopped w/o payload');
    assert(!cs.validateCaptureStatus({ schema: cs.CAPTURE_STATUS_SCHEMA, state: 'failed' }).ok, 'validate rejects failed w/o error');
    assert(!cs.validateCaptureStatus(null).ok, 'validate rejects null');
    console.log('capture-status-beacon-coverage: PASS -- media/captureStatus.mjs exercised across all states + branches');
  }

  // Coverage + behavior: the correlator auto-jump helpers (PR2, LBA-REQ-055) -- the correlator opens on the
  // beacon's peak-write frame so the human + agent land on the evidence.
  {
    assert(ext.peakFrameIndexOf({ peak: { frameIndex: 5 } }) === 5, 'peakFrameIndexOf reads a valid frame');
    assert(ext.peakFrameIndexOf({ peak: { frameIndex: -1 } }) === 0, 'peakFrameIndexOf clamps a negative to 0');
    assert(ext.peakFrameIndexOf({ peak: { frameIndex: 'x' } }) === 0, 'peakFrameIndexOf rejects a non-number');
    assert(ext.peakFrameIndexOf({ peak: {} }) === 0, 'peakFrameIndexOf handles a missing frameIndex');
    assert(ext.peakFrameIndexOf(undefined) === 0, 'peakFrameIndexOf handles an absent beacon');
    const pdir = join(tmpdir(), 'lba-test-peakframe-xyz');
    rmSync(pdir, { recursive: true, force: true });
    mkdirSync(pdir, { recursive: true });
    assert(ext.readPeakFrameIndex(pdir) === 0, 'readPeakFrameIndex returns 0 with no beacon');
    writeFileSync(join(pdir, 'capture-status.json'), JSON.stringify({ schema: 'labview-benchmark-actor/capture-status@1', state: 'stopped', peak: { frameIndex: 7 } }));
    assert(ext.readPeakFrameIndex(pdir) === 7, 'readPeakFrameIndex reads the beacon peak frame');
    writeFileSync(join(pdir, 'capture-status.json'), '{bad json');
    assert(ext.readPeakFrameIndex(pdir) === 0, 'readPeakFrameIndex returns 0 on a bad beacon');
    rmSync(pdir, { recursive: true, force: true });
    assert(ext.clampFrameIndex(2, 5) === 2 && ext.clampFrameIndex(99, 5) === 0 && ext.clampFrameIndex(-1, 5) === 0 && ext.clampFrameIndex(0, 0) === 0, 'clampFrameIndex bounds the auto-jump target into [0,count)');
    const cm = ext.buildCorrelatorModel([{ index: 0 }, { index: 1 }, { index: 2 }], 2, [{ frameIndex: 1 }], ['0 C:']);
    assert(cm.selectedIndex === 2 && cm.frames.length === 3 && cm.markers.length === 1 && cm.diskNames[0] === '0 C:' && cm.fps === 12, 'buildCorrelatorModel builds the model + clamps to the auto-jump index');
    assert(ext.buildCorrelatorModel(null, 99, null, undefined).selectedIndex === 0 && ext.buildCorrelatorModel(null, 0, null, undefined).frames.length === 0, 'buildCorrelatorModel tolerates non-array frames/markers');
    const fr = ext.buildCorrelatorFrame({ index: 3, tMs: 250, cpuPct: 10, ramMb: 200, diskPct: 5, disks: [{ name: '0 C:' }], counters: { a: 1 } }, 'vscode-webview://img.png');
    assert(fr.index === 3 && fr.tMs === 250 && fr.cpuPct === 10 && fr.ramMb === 200 && fr.diskPct === 5 && fr.imageSrc === 'vscode-webview://img.png' && fr.disks[0].name === '0 C:' && fr.counters.a === 1, 'buildCorrelatorFrame maps a capture frame + webview image src');
    const rdir = join(tmpdir(), 'lba-test-resamples-xyz');
    rmSync(rdir, { recursive: true, force: true });
    mkdirSync(rdir, { recursive: true });
    assert(ext.readResourceSamples(rdir).length === 0, 'readResourceSamples returns [] with no resources.jsonl');
    writeFileSync(join(rdir, 'resources.jsonl'), '{"ms":1,"cpuPct":10}\n\n  \n{bad json\n{"ms":2,"cpuPct":20}\n');
    const rsamples = ext.readResourceSamples(rdir);
    assert(rsamples.length === 2 && rsamples[0].ms === 1 && rsamples[1].cpuPct === 20, 'readResourceSamples parses valid lines + skips blank/partial');
    rmSync(rdir, { recursive: true, force: true });
    console.log('correlator-autojump-helpers: PASS -- peakFrameIndexOf + readPeakFrameIndex + clampFrameIndex + buildCorrelatorModel + buildCorrelatorFrame + readResourceSamples across all branches');
  }

  // Coverage: the staged media/handoffRequest.mjs (agent<->human request payloads, PR3, LBA-REQ-056), exercised
  // across every builder/validator/selector branch (the extension loads this at runtime; media/** is c8-covered).
  {
    const hr = await import(pathToFileURL(join(repoRoot, 'media', 'handoffRequest.mjs')).href);
    const req = hr.buildAgentRequest({ id: 'r1', title: 'Run the VI', body: 'then Stop', createdAt: 't0' });
    assert(req.schema === hr.AGENT_REQUEST_SCHEMA && req.kind === 'step' && req.body === 'then Stop', 'agent-request defaults');
    assert(hr.buildAgentRequest({ id: 'x', title: 't', kind: 'ack' }).kind === 'ack' && hr.buildAgentRequest({ id: 'x', title: 't', kind: 'bad' }).kind === 'step', 'agent-request kind branch');
    assert(hr.buildAgentRequest({}).id === null && hr.buildAgentRequest({}).body === '', 'agent-request null/empty defaults');
    const done = hr.buildOpDone({ requestId: 'r1', outcome: 'done', note: 'ok', doneAt: 't1' });
    assert(done.schema === hr.OP_DONE_SCHEMA && done.id === 'r1' && done.note === 'ok', 'op-done defaults its id to requestId');
    assert(hr.buildOpDone({ requestId: 'r' }).outcome === 'done' && hr.buildOpDone({ requestId: 'r', outcome: 'skipped' }).outcome === 'skipped' && hr.buildOpDone({ requestId: 'r', outcome: 'z' }).outcome === 'done', 'op-done outcome branch');
    assert(hr.buildOpDone({ requestId: 'r', note: '' }).note === null, 'op-done empty note -> null');
    assert(hr.validateAgentRequest(req).ok && !hr.validateAgentRequest({ schema: 'no', id: 'a', title: 't' }).ok, 'validateAgentRequest schema');
    assert(!hr.validateAgentRequest({ schema: hr.AGENT_REQUEST_SCHEMA, id: '', title: 't' }).ok && !hr.validateAgentRequest({ schema: hr.AGENT_REQUEST_SCHEMA, id: 'a', title: '' }).ok, 'validateAgentRequest id/title');
    assert(!hr.validateAgentRequest({ schema: hr.AGENT_REQUEST_SCHEMA, id: 'a', title: 't', kind: 'bad' }).ok && !hr.validateAgentRequest(null).ok, 'validateAgentRequest kind/null');
    assert(hr.validateOpDone(done).ok && !hr.validateOpDone({ schema: 'no', requestId: 'a', outcome: 'done' }).ok, 'validateOpDone schema');
    assert(!hr.validateOpDone({ schema: hr.OP_DONE_SCHEMA, requestId: '', outcome: 'done' }).ok && !hr.validateOpDone({ schema: hr.OP_DONE_SCHEMA, requestId: 'a', outcome: 'z' }).ok && !hr.validateOpDone(null).ok, 'validateOpDone requestId/outcome/null');
    const reqs = [hr.buildAgentRequest({ id: 'a', title: 't', createdAt: '1' }), hr.buildAgentRequest({ id: 'b', title: 't', createdAt: '2' }), { schema: 'no', id: 'bad', title: 'x' }];
    assert(hr.selectPendingRequest(reqs, []).id === 'b' && hr.selectPendingRequest(reqs, ['b']).id === 'a' && hr.selectPendingRequest(reqs, ['a', 'b']) === null, 'selectPendingRequest newest-unanswered');
    assert(hr.selectPendingRequest([hr.buildAgentRequest({ id: 'a', title: 't', createdAt: '1' }), hr.buildAgentRequest({ id: 'b', title: 't', createdAt: '1' })], []).id === 'b', 'selectPendingRequest id tie-break on equal createdAt');
    assert(hr.selectPendingRequest('x', 'y') === null && hr.selectPendingRequest([], []) === null, 'selectPendingRequest non-array/empty');
    console.log('handoff-request-media-coverage: PASS -- media/handoffRequest.mjs exercised across all branches');
  }

  // Coverage + behavior: the extension's Handoff Beacon fs helpers (PR3, LBA-REQ-056).
  {
    const hp = ext.handoffPaths(join('gs', 'root'));
    assert(hp.root.endsWith('handoff') && hp.requestsDir.endsWith(join('handoff', 'requests')) && hp.doneDir.endsWith(join('handoff', 'done')), 'handoffPaths derives requests/ + done/ under handoff/');
    const hdir = join(tmpdir(), 'lba-test-handoff-xyz');
    rmSync(hdir, { recursive: true, force: true });
    mkdirSync(join(hdir, 'requests'), { recursive: true });
    mkdirSync(join(hdir, 'done'), { recursive: true });
    assert(ext.readJsonDir(join(hdir, 'requests')).length === 0, 'readJsonDir empty on an empty dir');
    assert(ext.readJsonDir(join(hdir, 'missing')).length === 0, 'readJsonDir returns [] for a missing dir');
    writeFileSync(join(hdir, 'requests', 'r1.json'), JSON.stringify({ schema: 'labview-benchmark-actor/agent-request@1', id: 'r1', title: 'do a thing' }));
    writeFileSync(join(hdir, 'requests', 'note.txt'), 'ignored');
    writeFileSync(join(hdir, 'requests', 'bad.json'), '{oops');
    const jreqs = ext.readJsonDir(join(hdir, 'requests'));
    assert(jreqs.length === 1 && jreqs[0].id === 'r1', 'readJsonDir parses valid *.json + skips non-json/partial');
    writeFileSync(join(hdir, 'done', 'r1.json'), JSON.stringify({ schema: 'labview-benchmark-actor/op-done@1', requestId: 'r1', outcome: 'done' }));
    writeFileSync(join(hdir, 'done', 'nokey.json'), JSON.stringify({ foo: 1 }));
    const answered = ext.answeredRequestIds(join(hdir, 'done'));
    assert(answered.length === 1 && answered[0] === 'r1', 'answeredRequestIds returns the request ids that have an op-done');
    rmSync(hdir, { recursive: true, force: true });
    console.log('handoff-request-helpers: PASS -- handoffPaths + readJsonDir + answeredRequestIds across all branches');
  }

  // createCleanroom input VALIDATION: an invalid name/port/actor is rejected by the validators and aborts the
  // command early (each `if (!x) return`). The mock treats a validation failure as the user cancelling (VS Code
  // blocks OK on an invalid value), so no cloner command is sent.
  {
    const cc = registered.find((r) => r.id === 'labviewBenchmarkActor.createCleanroom').handler;
    const sentBeforeInvalid = sentCommands.length;
    inputQueue.push('bad name!'); // cloneName invalid -> reject + early return
    await cc();
    inputQueue.push('ok-name', '99999'); // sshPort out of range -> reject + early return
    await cc();
    inputQueue.push('ok-name', '2223', 'not-a-port'); // workerPort invalid -> reject + early return
    await cc();
    inputQueue.push('ok-name', '2223', '7441', 'bad actor!'); // actorId invalid -> reject + early return
    await cc();
    assert(sentCommands.length === sentBeforeInvalid, 'createCleanroom aborts (sends no cloner command) when any input fails validation');
  }

  // captureLaunch with no resolvable LabVIEW -> the "LabVIEW.exe not found" guard, returning BEFORE any spawn
  // (the ffmpeg/proc capture itself is cleanroom-gated + live-proven, never faked). Point labviewPath at a
  // guaranteed-nonexistent file so this stays hermetic on a real LabVIEW dev host, where the default
  // C:\Program Files\...\LabVIEW 2026\LabVIEW.exe candidate exists and resolveLabview would otherwise pass.
  const errsBeforeCapture = errorMessages.length;
  configStore.labviewPath = join(tmpdir(), 'lba-no-labview-here-xyz', 'LabVIEW.exe');
  await registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunch').handler();
  delete configStore.labviewPath;
  assert(
    errorMessages.slice(errsBeforeCapture).some((m) => /LabVIEW\.exe not found/.test(m)),
    'captureLaunch surfaces the LabVIEW-not-found guard when no LabVIEW is resolvable'
  );

  // lmTextResult fallback: when the host predates the LanguageModelToolResult/TextPart classes, the tools return
  // a plain { content:[{type,value}] } shape instead of the API objects.
  {
    const savedResult = mockVscode.LanguageModelToolResult;
    const savedPart = mockVscode.LanguageModelTextPart;
    mockVscode.LanguageModelToolResult = undefined;
    mockVscode.LanguageModelTextPart = undefined;
    const summaryTool = registeredTools.find((x) => x.name === 'lba-benchmark-summary');
    const res = await summaryTool.tool.invoke({}, {});
    assert(
      res && Array.isArray(res.content) && res.content[0] && typeof res.content[0].value === 'string',
      'lmTextResult falls back to a plain content shape when the LM API classes are absent'
    );
    mockVscode.LanguageModelToolResult = savedResult;
    mockVscode.LanguageModelTextPart = savedPart;
  }

  // Benchmark panel commands (LBA-REQ-004/005): each renders a webview from the STAGED fixtures. Invoking them
  // covers the extension.ts panel wiring (loadPanelBuilders + loadBenchmarkJson + makeBenchmarkPanel) on the
  // real render path -- the panel builders themselves are proven separately by panels-render.mjs.
  const panelCommands = [
    'labviewBenchmarkActor.openBenchmarkRun',
    'labviewBenchmarkActor.openBenchmarkTrend',
    'labviewBenchmarkActor.openCrossPlaneTrend',
    'labviewBenchmarkActor.openResourceProfile',
    'labviewBenchmarkActor.openCrossPlaneResource',
    'labviewBenchmarkActor.openMeshCalibration',
    'labviewBenchmarkActor.openMeshBoard',
  ];
  const panelsBefore = panels.length;
  for (const id of panelCommands) {
    const cmd = registered.find((r) => r.id === id);
    assert(cmd, `${id} command is registered`);
    await cmd.handler();
  }
  assert(
    panels.length === panelsBefore + panelCommands.length,
    'each benchmark panel command renders a webview from the staged fixtures'
  );
  assert(
    panels.slice(panelsBefore).every((p) => typeof p.webview.html === 'string' && p.webview.html.length > 0),
    'each benchmark panel sets non-empty HTML (fixtures loaded -- the real render path, not the error path)'
  );
  // the mesh-stress calibration panel specifically renders the script-free analysis view (LBA-REQ-032, VW-1).
  assert(
    panels.slice(panelsBefore).some((p) => /Mesh-Stress Calibration &mdash; Analysis view/.test(p.webview.html) && /script-src 'none'/.test(p.webview.html)),
    'openMeshCalibration renders the inert mesh calibration analysis view from the staged live-ladder receipt'
  );
  // the concurrent mesh board panel renders the inert live-snapshot board (LBA-REQ-032, VW-1).
  assert(
    panels.slice(panelsBefore).some((p) => /Concurrent Mesh Board &mdash; who is stressed/.test(p.webview.html) && /script-src 'none'/.test(p.webview.html)),
    'openMeshBoard renders the inert concurrent mesh board from the staged concurrent-actors receipt'
  );
  // Cover the staged mesh view builders' DEFENSIVE branches directly: the extension only renders them on the
  // all-recovered happy path (openMeshCalibration/openMeshBoard), leaving the failing-invariant / not-recovered
  // / missing-field / no-cspSource branches uncovered under the media/** coverage scope. (Both builders are also
  // fully proven by meshBoardView.selftest / meshCalibrationView.selftest in verify-local-gates.)
  {
    const board = await import(pathToFileURL(join(repoRoot, 'media', 'meshBoardView.mjs')).href);
    const boardHtml = board.buildMeshBoardHtml({
      schema: '<x>', host: {}, measured: {}, concurrency: {}, invariants: { monotone: 0.5, separable: false, repeatable: false },
      actors: [{ actor: 'a', rung: null, cpuPoolPctMean: 150 }, { actor: 'b', rung: 'x', cpuPoolPctMean: -5 }],
      perActorInverseRead: [{ actor: 'a', inferredRung: null, correct: false }],
    }); // no cspSource -> the 'none' CSP fallback + the not-recovered / missing-field / failing-badge branches
    assert(/mb-mark no/.test(boardHtml) && /script-src 'none'/.test(boardHtml), 'mesh board renders the not-recovered + no-cspSource defensive branches');

    const cal = await import(pathToFileURL(join(repoRoot, 'media', 'meshCalibrationView.mjs')).href);
    const calHtml = cal.buildMeshCalibrationHtml({
      schema: 'x', host: {}, ladder: {}, cpuTotalPctMeanCurve: [], separability: [], salientDimensions: [],
      invariants: { monotone: 0.2, separable: false, repeatable: false }, inverseRead: {},
    }); // failing invariants + empty curve -> the 'no' badges + empty-SVG branches
    assert(/mc-badge no/.test(calHtml), 'mesh calibration renders the failing-invariant defensive branches');
  }

  // pollBus + postNote (CLI-backed): child_process is mocked to ENOENT, so both surface remediation via runCli.
  await registered.find((r) => r.id === 'labviewBenchmarkActor.pollBus').handler();
  inputQueue.push('NOTE test coordination note');
  await registered.find((r) => r.id === 'labviewBenchmarkActor.postNote').handler();

  // LM open-benchmark-panel tool: opens a panel (reusing a panel command) and returns descriptive text.
  const openPanelTool = registeredTools.find((t) => t.name === 'lba-open-benchmark-panel');
  assert(openPanelTool, 'the open-benchmark-panel LM tool is registered');
  const openResult = await openPanelTool.tool.invoke({ input: { panel: 'run' } }, {});
  const openText = openResult && openResult.content && openResult.content[0] && openResult.content[0].value;
  assert(typeof openText === 'string' && /panel/i.test(openText), 'the open-panel LM tool opens a panel + returns text');

  // Capture commands (LBA-REQ-009): with no resolvable LabVIEW the capture short-circuits at resolveLabview,
  // covering resolveFfmpeg + resolveLabview + captureCfg + the early guards. The ffmpeg/sampler spawn + the
  // frame correlator run on a Windows cleanroom (LabVIEW + ffmpeg), not in this unit test. labviewPath points at
  // a guaranteed-nonexistent file so this is hermetic even on a host that HAS LabVIEW 2026 installed.
  const errsBeforeNoLv = errorMessages.length;
  configStore.labviewPath = join(tmpdir(), 'lba-no-labview-here-xyz', 'LabVIEW.exe');
  await registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunch').handler();
  delete configStore.labviewPath;
  assert(
    errorMessages.slice(errsBeforeNoLv).some((m) => /LabVIEW\.exe not found/.test(m)),
    'captureLaunch reports missing LabVIEW (resolveLabview -> null) and returns before spawning ffmpeg'
  );
  await registered.find((r) => r.id === 'labviewBenchmarkActor.stopCapture').handler();
  assert(
    infoMessages.some((m) => /No LabVIEW capture is running/.test(m)),
    'stopCapture reports no active capture'
  );

  // ffmpeg pre-flight (v1.0.0 "spawn ffmpeg.exe ENOENT" fix, LBA-REQ-009): resolveFfmpegChecked returns null unless
  // ffmpeg is a spawnable binary, so the capture fails FAST with an actionable prompt instead of a raw spawn error.
  {
    assert(ext.ffmpegRunnable(process.execPath) === true, 'ffmpegRunnable detects a spawnable binary (node stands in)');
    assert(ext.ffmpegRunnable(join(tmpdir(), 'no-such-ffmpeg-xyz')) === false, 'ffmpegRunnable is false for a missing binary');
    configStore.ffmpegPath = process.execPath;
    assert(ext.resolveFfmpegChecked() === process.execPath, 'resolveFfmpegChecked returns a configured runnable ffmpeg');
    configStore.ffmpegPath = join(tmpdir(), 'no-such-ffmpeg-xyz');
    assert(ext.resolveFfmpegChecked() === null, 'resolveFfmpegChecked rejects a configured-but-unspawnable ffmpeg');
    delete configStore.ffmpegPath;
    const ladRoot = join(tmpdir(), 'lba-test-localappdata-' + Date.now());
    mkdirSync(join(ladRoot, 'lba'), { recursive: true });
    writeFileSync(join(ladRoot, 'lba', 'ffmpeg.exe'), '');
    const savedLad = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = ladRoot;
    assert(ext.resolveFfmpegChecked() === join(ladRoot, 'lba', 'ffmpeg.exe'), 'resolveFfmpegChecked honours the staged %LOCALAPPDATA%\\lba\\ffmpeg.exe');
    rmSync(ladRoot, { recursive: true, force: true });
    if (savedLad === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLad;
    // issue #405: a winget-installed ffmpeg (the "Install ffmpeg (winget)" button) symlinks ffmpeg.exe under
    // %LOCALAPPDATA%\Microsoft\WinGet\Links and adds that dir to the USER PATH; the extension-host process keeps the
    // PRE-install PATH (Reload Window does NOT refresh it), so resolveFfmpegChecked must find the freshly installed
    // ffmpeg via the stable winget Links location EVEN WHEN it is not on this process's (stale) PATH.
    const wgRoot = join(tmpdir(), 'lba-test-winget-links-' + Date.now());
    const wgLinks = join(wgRoot, 'Microsoft', 'WinGet', 'Links');
    mkdirSync(wgLinks, { recursive: true });
    const wgFfmpeg = join(wgLinks, 'ffmpeg.exe');
    copyFileSync(process.execPath, wgFfmpeg); // a real spawnable binary (node stands in) so ffmpegRunnable passes
    try { chmodSync(wgFfmpeg, 0o755); } catch { /* no-op on Windows */ }
    const savedPathWg = process.env.PATH;
    const savedLadWg = process.env.LOCALAPPDATA;
    process.env.PATH = join(tmpdir(), 'lba-no-ffmpeg-here-xyz'); // ffmpeg NOT on this (stale) process PATH
    process.env.LOCALAPPDATA = wgRoot;
    try {
      assert(ext.resolveFfmpegChecked() === wgFfmpeg, 'resolveFfmpegChecked finds a winget-installed ffmpeg (WinGet\\Links) not on the stale PATH (issue #405)');
    } finally {
      process.env.PATH = savedPathWg;
      if (savedLadWg === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLadWg;
      rmSync(wgRoot, { recursive: true, force: true });
    }
    // absent everywhere: clear PATH *and* point %LOCALAPPDATA% at a staged-ffmpeg-free dir so the `ffmpeg` probe
    // ENOENTs even on a host that HAS ffmpeg on PATH or staged under %LOCALAPPDATA%\lba\ffmpeg.exe (the reviewer WIN VM).
    const savedPath = process.env.PATH;
    const savedLadAbsent = process.env.LOCALAPPDATA;
    process.env.PATH = join(tmpdir(), 'lba-no-ffmpeg-here-xyz');
    process.env.LOCALAPPDATA = join(tmpdir(), 'lba-no-localappdata-ffmpeg-xyz');
    try {
      assert(ext.resolveFfmpegChecked() === null, 'resolveFfmpegChecked returns null when ffmpeg is absent everywhere');
    } finally {
      process.env.PATH = savedPath;
      if (savedLadAbsent === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLadAbsent;
    }
  }

  // captureLaunch with LabVIEW present but ffmpeg absent -> PROMPT (winget / download / set-path) + abort BEFORE any
  // capture is created (the reported v1.0.0 complaint). Drive each remediation button.
  {
    const savedPath = process.env.PATH;
    const savedLadPrompt = process.env.LOCALAPPDATA;
    process.env.PATH = join(tmpdir(), 'lba-no-ffmpeg-here-xyz'); // force ffmpeg-absent (the dev host may have ffmpeg)
    process.env.LOCALAPPDATA = join(tmpdir(), 'lba-no-localappdata-ffmpeg-xyz'); // ...and no %LOCALAPPDATA%\lba\ffmpeg.exe (the reviewer WIN VM stages one)
    configStore.labviewPath = process.execPath; // resolveLabview -> non-empty -> passes the LabVIEW guard
    const cap = () => registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunch').handler();

    const n0 = errorMessages.length;
    const s0 = sentCommands.length;
    errorResponseQueue.push('Install ffmpeg (winget)');
    await cap();
    assert(errorMessages.slice(n0).some((m) => /ffmpeg is required/i.test(m)), 'captureLaunch prompts when ffmpeg is missing');
    assert(sentCommands.slice(s0).some((c) => /winget install/i.test(c)), 'the Install button runs winget');

    const e0 = openedExternal.length;
    errorResponseQueue.push('Download ffmpeg\u2026');
    await cap();
    assert(openedExternal.slice(e0).some((u) => /ffmpeg/i.test(u)), 'the Download button opens the ffmpeg builds page');

    const c0 = executedCommands.length;
    errorResponseQueue.push('Set ffmpeg path\u2026');
    await cap();
    assert(executedCommands.slice(c0).some((x) => /openSettings/i.test(x)), 'the Set-ffmpeg-path button opens the ffmpegPath setting');

    await cap(); // no button chosen -> aborts cleanly (covers the no-choice branch)
    delete configStore.labviewPath;
    process.env.PATH = savedPath;
    if (savedLadPrompt === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLadPrompt;
  }

  // captureLaunchMprr (cross-platform mprr capture, LBA-REQ-009): drive the FULL command with a mocked `node`
  // spawn of the mprr runner -- success (trend written -> info + Open Trend JSON), the info-dismissed branch, a
  // non-zero exit, a spawn error, and the runner-missing / no-workspace guards. The real capture runs live
  // against a VM (proven separately); only the extension glue is exercised here.
  {
    const mprr = () => registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunchMprr').handler();
    spawnMode = { code: 0 };
    infoResponseQueue.push('Open Trend JSON');
    const infoBefore = infoMessages.length;
    await mprr();
    assert(
      infoMessages.slice(infoBefore).some((m) => /launchMs mean 1866/.test(m)),
      'captureLaunchMprr reports the captured launchMs trend on success + offers Open Trend JSON'
    );
    spawnMode = { code: 0 }; // success again, info dismissed -> the open-doc branch is skipped
    await mprr();
    spawnMode = { code: 1 };
    const errBefore = errorMessages.length;
    await mprr();
    assert(
      errorMessages.slice(errBefore).some((m) => /mprr capture failed \(exit 1\)/.test(m)),
      'captureLaunchMprr surfaces a non-zero exit as an error'
    );
    spawnMode = { error: true };
    const errBefore2 = errorMessages.length;
    await mprr();
    assert(
      errorMessages.slice(errBefore2).some((m) => /mprr capture failed to start/.test(m)),
      'captureLaunchMprr surfaces a spawn error'
    );
    const savedFoldersMprr = mockVscode.workspace.workspaceFolders;
    mockVscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpdir(), path: tmpdir() } }];
    const errBefore3 = errorMessages.length;
    await mprr();
    assert(
      errorMessages.slice(errBefore3).some((m) => /mprr runner not found/.test(m)),
      'captureLaunchMprr guards on a workspace missing the mprr runner'
    );
    mockVscode.workspace.workspaceFolders = undefined;
    const errBefore4 = errorMessages.length;
    await mprr();
    assert(
      errorMessages.slice(errBefore4).some((m) => /needs the labview-benchmark-actor repo open/.test(m)),
      'captureLaunchMprr guards on no workspace folder'
    );
    mockVscode.workspace.workspaceFolders = savedFoldersMprr;
  }

  // Open Frame Correlator, three ways. First with NO captures on disk (a clean nonexistent dir): it guides
  // the user to run Capture LabVIEW Launch (the empty-captures branch).
  rmSync(gsRoot, { recursive: true, force: true });
  await registered.find((r) => r.id === 'labviewBenchmarkActor.openFrameCorrelator').handler();
  assert(
    infoMessages.some((m) => /No LabVIEW capture yet/.test(m)),
    'openFrameCorrelator with no captures guides the user to Capture LabVIEW Launch'
  );
  // ...and when the user clicks the guidance button, it dispatches the capture command.
  infoResponseQueue.push('Capture LabVIEW Launch');
  await registered.find((r) => r.id === 'labviewBenchmarkActor.openFrameCorrelator').handler();
  assert(
    executedCommands.includes('labviewBenchmarkActor.captureLaunch'),
    'picking the guidance button dispatches labviewBenchmarkActor.captureLaunch'
  );
  // ...and with a real VM-local capture on disk, it loads the latest capture.json and RENDERS the frame
  // correlator webview (openCorrelatorForCapture: the staged frame-correlator.mjs builder + per-frame webview
  // URIs). A minimal launch-capture@1 fixture under the (real) globalStorage captures dir drives it.
  const captureRunDir = join(gsRoot, 'captures', 'run-20260731');
  mkdirSync(captureRunDir, { recursive: true });
  writeFileSync(join(captureRunDir, 'capture.json'), JSON.stringify({
    frameCount: 2,
    counterKeys: ['cpuTotalPct', 'memAvailableMb'],
    frames: [
      { index: 0, tMs: 0, cpuPct: 10, ramMb: 2000, diskPct: 1, counters: { cpuTotalPct: 10, memAvailableMb: 4000 }, image: 'frame-00000.png' },
      { index: 1, tMs: 83, cpuPct: 12, ramMb: 2010, diskPct: 2, counters: { cpuTotalPct: 12, memAvailableMb: 3990 }, image: 'frame-00001.png' },
    ],
  }));
  const panelsBeforeCorrelator = panels.length;
  await registered.find((r) => r.id === 'labviewBenchmarkActor.openFrameCorrelator').handler();
  assert(panels.length === panelsBeforeCorrelator + 1, 'openFrameCorrelator renders a webview panel from the latest capture on disk');
  assert(/fc-root|Content-Security-Policy/.test(panels[panels.length - 1].webview.html), 'the frame-correlator webview HTML is built from the capture record');
  // v2: the capture's per-frame counters{} flow through openCorrelatorForCapture into the webview model island.
  {
    const island = JSON.parse(panels[panels.length - 1].webview.html.match(/<script id="fc-model"[^>]*>([\s\S]*?)<\/script>/)[1].replace(/\\u003c/g, '<'));
    assert(island.frames[0].counters && island.frames[0].counters.cpuTotalPct === 10, 'the correlator passes the capture v2 counters{} through to the webview');
  }
  // a CLICK marker posted by the webview is persisted into the capture metadata ("mouse click -> label in
  // metadata"); unrelated / empty messages are ignored; reopening the correlator seeds the persisted markers.
  const corrPanel = panels[panels.length - 1];
  corrPanel.webview._msgHandler(undefined); // ignored (!msg)
  corrPanel.webview._msgHandler({ type: 'noise' }); // ignored (type mismatch)
  corrPanel.webview._msgHandler({ type: 'frame-marker' }); // ignored (!marker)
  corrPanel.webview._msgHandler({ type: 'frame-marker', marker: { id: 'm-83-1', instantMs: 83, frameIndex: 1, kind: 'user-click', imageGrab: { admitted: true, deltaMs: 0 } } });
  corrPanel.webview._msgHandler({ type: 'frame-marker', marker: { id: 'm-0-2', instantMs: 0, frameIndex: 0, kind: 'user-click', imageGrab: { admitted: true, deltaMs: 0 } } });
  const persisted = JSON.parse(readFileSync(join(captureRunDir, 'capture.json'), 'utf8'));
  assert(
    Array.isArray(persisted.markers) && persisted.markers.length === 2 && persisted.markers[0].frameIndex === 1,
    'posted frame-markers are appended to capture.json metadata (unrelated/empty messages ignored)'
  );
  await registered.find((r) => r.id === 'labviewBenchmarkActor.openFrameCorrelator').handler();
  assert(/m-83-1/.test(panels[panels.length - 1].webview.html), 'reopening the correlator seeds the persisted markers back into the webview');
  // a persist failure is swallowed (corrupt capture.json -> the try/catch logs, never throws into the webview)
  writeFileSync(join(captureRunDir, 'capture.json'), 'not json{');
  corrPanel.webview._msgHandler({ type: 'frame-marker', marker: { id: 'm-x', frameIndex: 3 } });
  rmSync(gsRoot, { recursive: true, force: true });

  // Error-path coverage: re-activate against an extensionUri that lacks media/ so the panel fixture loads throw
  // -> each command's catch -> reportUiError (graceful degradation on a corrupt/missing install, not a crash).
  // Route the second activation's registrations to a separate list so the primary command surface stays clean.
  const second = [];
  const savedRegisterCommand = mockVscode.commands.registerCommand;
  const savedRegisterTool = mockVscode.lm.registerTool;
  mockVscode.commands.registerCommand = (id, handler) => { second.push({ id, handler }); return { dispose() {} }; };
  mockVscode.lm.registerTool = () => ({ dispose() {} });
  ext.activate({ subscriptions: [], extensionUri: { path: brokenExtRoot, fsPath: brokenExtRoot }, globalStorageUri: { fsPath: brokenGsRoot }, extension: { packageJSON: { version: '0.1.0' } } });
  mockVscode.commands.registerCommand = savedRegisterCommand;
  mockVscode.lm.registerTool = savedRegisterTool;
  const errBefore = errorMessages.length;
  for (const id of ['openBenchmarkRun', 'openBenchmarkTrend', 'openCrossPlaneTrend', 'openResourceProfile', 'openCrossPlaneResource', 'openMeshCalibration', 'openMeshBoard']) {
    await second.find((r) => r.id === `labviewBenchmarkActor.${id}`).handler();
  }
  assert(
    errorMessages.length >= errBefore + 7,
    'each panel command reports a UI error (reportUiError) when the staged fixtures are unreadable (graceful degradation, not a crash)'
  );

  // openViewer on the broken install: loadSeries cannot read media/mprr-series.json, so it falls back to the
  // built-in demo series (the viewer always renders a valid series).
  const panelsBeforeBrokenViewer = panels.length;
  second.find((r) => r.id === 'labviewBenchmarkActor.openViewer').handler();
  assert(panels.length === panelsBeforeBrokenViewer + 1, 'openViewer still renders on a broken install (loadSeries demo-series fallback)');

  // Script-resolution guards + the postNote empty-input abort, on the broken install with NO workspace folder:
  // createCleanroom + bootstrapAuthoringLane can resolve no script -> each surfaces its "not found" guidance,
  // and postNote with no message entered aborts before the CLI.
  const savedFoldersBroken = mockVscode.workspace.workspaceFolders;
  mockVscode.workspace.workspaceFolders = undefined;
  const errBeforeScripts = errorMessages.length;
  // createCleanroom refuses on a Windows host BEFORE resolving the script; fake a POSIX host so it reaches the
  // cloner-not-found guard regardless of the CI OS.
  const brokenPlatDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await second.find((r) => r.id === 'labviewBenchmarkActor.createCleanroom').handler();
  } finally {
    Object.defineProperty(process, 'platform', brokenPlatDesc);
  }
  await second.find((r) => r.id === 'labviewBenchmarkActor.bootstrapAuthoringLane').handler();
  assert(errorMessages.slice(errBeforeScripts).some((m) => /Cleanroom cloner not found/.test(m)), 'createCleanroom reports the cloner-not-found guard when no script resolves');
  assert(errorMessages.slice(errBeforeScripts).some((m) => /Authoring-lane bootstrap not found/.test(m)), 'bootstrapAuthoringLane reports the bootstrap-not-found guard when no script resolves');
  await second.find((r) => r.id === 'labviewBenchmarkActor.runCorroborationGrid').handler();
  await second.find((r) => r.id === 'labviewBenchmarkActor.verifyReleaseProvenance').handler();
  assert(errorMessages.slice(errBeforeScripts).some((m) => /Corroboration grid runner not found/.test(m)), 'runCorroborationGrid reports the runner-not-found guard when no script resolves');
  assert(errorMessages.slice(errBeforeScripts).some((m) => /Release-provenance verifier not found/.test(m)), 'verifyReleaseProvenance reports the verifier-not-found guard when no script resolves');
  // runThroughputLadder refuses on win32 BEFORE resolving; fake a POSIX host so it reaches the runner-not-found guard.
  const ladderPlatDesc = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  try {
    await second.find((r) => r.id === 'labviewBenchmarkActor.runThroughputLadder').handler();
  } finally {
    Object.defineProperty(process, 'platform', ladderPlatDesc);
  }
  assert(errorMessages.slice(errBeforeScripts).some((m) => /Throughput ladder runner not found/.test(m)), 'runThroughputLadder reports the runner-not-found guard when no script resolves');
  await second.find((r) => r.id === 'labviewBenchmarkActor.postNote').handler(); // empty inputQueue -> no message -> abort before the CLI
  mockVscode.workspace.workspaceFolders = savedFoldersBroken;

  ext.deactivate(); // must not throw

  // Language-model tools (Copilot agent mode): activate() registers the two agent-facing tools, and the
  // summary tool returns text (invoked here to exercise the path).
  const toolNames = registeredTools.map((t) => t.name);
  assert(toolNames.includes('lba-open-benchmark-panel'), 'activate() registers the open-benchmark-panel LM tool');
  assert(toolNames.includes('lba-benchmark-summary'), 'activate() registers the benchmark-summary LM tool');
  const summaryTool = registeredTools.find((t) => t.name === 'lba-benchmark-summary');
  const summaryResult = await summaryTool.tool.invoke({ input: {} }, {});
  const summaryText = summaryResult && summaryResult.content && summaryResult.content[0] && summaryResult.content[0].value;
  assert(typeof summaryText === 'string' && /LabVIEW Benchmark Actor/.test(summaryText), 'the summary LM tool returns text');

  // Handoff Beacon agent->human flow (PR3, LBA-REQ-056): a pending request surfaces via refreshHandoffRequests
  // as a notification whose action writes the op-done beacon. Deterministic + ISOLATED -- awaits
  // refreshHandoffRequests directly and stubs the notification/input responses inline (no shared queue, no
  // fs.watch race) so it is stable on every CI runner. Covers refreshHandoffRequests + mark/skip + writeOpDoneBeacon.
  {
    const mkOut = () => ({ appendLine() {}, show() {}, dispose() {} });
    const ctxFor = (gs) => ({ globalStorageUri: { fsPath: gs }, extensionUri: { path: repoRoot, fsPath: repoRoot } });
    const seedReq = (gs, id, title, createdAt) => {
      rmSync(gs, { recursive: true, force: true });
      mkdirSync(join(gs, 'handoff', 'requests'), { recursive: true });
      writeFileSync(join(gs, 'handoff', 'requests', `${id}.json`), JSON.stringify({ schema: 'labview-benchmark-actor/agent-request@1', id, title, body: '', kind: 'step', createdAt }));
    };
    const savedInfo = mockVscode.window.showInformationMessage;
    const savedInput = mockVscode.window.showInputBox;

    // (1) "Mark step done" with a note -> op-done { done, note }.
    const gsDone = join(tmpdir(), 'lba-test-handoff-done-xyz');
    seedReq(gsDone, 'req-done', 'Run the streaming VI, then Stop', '2026-08-03T00:00:00Z');
    mockVscode.window.showInformationMessage = () => 'Mark step done';
    mockVscode.window.showInputBox = async () => 'ran VI #3';
    await ext.refreshHandoffRequests(ctxFor(gsDone), mkOut());
    const opDone = JSON.parse(readFileSync(join(gsDone, 'handoff', 'done', 'req-done.json'), 'utf8'));
    assert(opDone.requestId === 'req-done' && opDone.outcome === 'done' && opDone.note === 'ran VI #3', `handoff: op-done records done + the note (got ${JSON.stringify(opDone)})`);

    // (2) "Skip" -> op-done { skipped, note:null }.
    const gsSkip = join(tmpdir(), 'lba-test-handoff-skip-xyz');
    seedReq(gsSkip, 'req-skip', 'Activate LabVIEW', '2026-08-03T00:05:00Z');
    mockVscode.window.showInformationMessage = () => 'Skip';
    await ext.refreshHandoffRequests(ctxFor(gsSkip), mkOut());
    const opSkip = JSON.parse(readFileSync(join(gsSkip, 'handoff', 'done', 'req-skip.json'), 'utf8'));
    assert(opSkip.outcome === 'skipped' && opSkip.note === null, 'handoff: op-done records skipped');

    // (3) A dismissed notification (no action chosen) writes no answer.
    const gsDismiss = join(tmpdir(), 'lba-test-handoff-dismiss-xyz');
    seedReq(gsDismiss, 'req-dismiss', 'Some step', '2026-08-03T00:07:00Z');
    mockVscode.window.showInformationMessage = () => undefined;
    await ext.refreshHandoffRequests(ctxFor(gsDismiss), mkOut());
    assert(!existsSync(join(gsDismiss, 'handoff', 'done', 'req-dismiss.json')), 'handoff: a dismissed notification writes no op-done');
    mockVscode.window.showInformationMessage = savedInfo;
    mockVscode.window.showInputBox = savedInput;

    // (4) No pending: refresh with an empty requests dir clears the active request; the mark/skip commands no-op.
    const gsEmpty = join(tmpdir(), 'lba-test-handoff-empty-xyz');
    rmSync(gsEmpty, { recursive: true, force: true });
    mkdirSync(join(gsEmpty, 'handoff', 'requests'), { recursive: true });
    await ext.refreshHandoffRequests(ctxFor(gsEmpty), mkOut());
    await registered.find((r) => r.id === 'labviewBenchmarkActor.markStepDone').handler();
    await registered.find((r) => r.id === 'labviewBenchmarkActor.skipStep').handler();
    console.log('handoff-request-flow: PASS -- refreshHandoffRequests -> Mark done/Skip/dismiss -> op-done beacon (+ no-pending no-op)');
  }

  // Reviewer VISUAL VERDICT (PR4, LBA-REQ-057): the staged media/reviewerVerdict.mjs + the extension helpers +
  // the Render Reviewer Verdict command that Ed25519-signs a verdict IN the VM.
  const rv = await import(pathToFileURL(join(repoRoot, 'media', 'reviewerVerdict.mjs')).href);
  const rvKeys = rv.generateEnrolledKeypair();
  {
    const target = { component: 'extension', version: '0.5.0', commit: 'a'.repeat(40), vsixSha256: 'b'.repeat(64) };
    const reviewer = 'rev@x';
    const allow = { [reviewer]: rvKeys.publicKeyPem };
    const v = rv.buildReviewerVerdict({ target, verdict: 'pass', reviewer, station: 'WINDOWS_VM', notes: 'ok', evidence: [{ kind: 'capture', ref: 'run-1' }, { kind: 'x' }], renderedAt: 't' });
    assert(v.schema === rv.REVIEWER_VERDICT_SCHEMA && v.verdict === 'pass' && v.evidence.length === 1, 'buildReviewerVerdict builds + drops evidence without a ref');
    assert(rv.buildReviewerVerdict({}).verdict === 'fail' && rv.buildReviewerVerdict({ verdict: 'z' }).station === 'WINDOWS_VM', 'reviewer-verdict verdict/station defaults');
    assert(rv.validateReviewerVerdict(v).ok && !rv.validateReviewerVerdict({ ...v, verdict: 'z' }).ok && !rv.validateReviewerVerdict({ ...v, target: { version: '', commit: '' } }).ok && !rv.validateReviewerVerdict({ ...v, reviewer: '' }).ok && !rv.validateReviewerVerdict({ ...v, station: 'MARS' }).ok && !rv.validateReviewerVerdict(null).ok, 'validateReviewerVerdict fail-closed');
    const s = rv.signReviewerVerdict(v, { privateKeyPem: rvKeys.privateKeyPem, reviewer, station: 'WINDOWS_VM' });
    assert(s.schema === rv.SIGNOFF_SCHEMA && s.decision === 'approve' && s.subject.verdictDigest === rv.reviewerVerdictDigest(v), 'signReviewerVerdict -> acg-human-signoff-v1 bound to the digest');
    assert(rv.signReviewerVerdict(rv.buildReviewerVerdict({ target, verdict: 'fail', reviewer }), { privateKeyPem: rvKeys.privateKeyPem, reviewer }).decision === 'reject', 'a fail verdict -> reject');
    assert(rv.verifyReviewerVerdict(v, s, { reviewerAllowlist: allow }).ok, 'verifyReviewerVerdict verifies a good sign-off');
    assert(!rv.verifyReviewerVerdict({ ...v, notes: 'x' }, s, { reviewerAllowlist: allow }).ok && !rv.verifyReviewerVerdict(v, s, { reviewerAllowlist: {} }).ok && !rv.verifyReviewerVerdict(v, { schema: 'no' }, { reviewerAllowlist: allow }).ok, 'verifyReviewerVerdict fail-closed');
    assert(rv.gateVisualReview({ verdict: v, signOffs: [s], reviewerAllowlist: allow, minReviewers: 1 }).publish === true, 'gateVisualReview publishes on pass + approval');
    assert(rv.gateVisualReview({ verdict: v, signOffs: [], reviewerAllowlist: allow }).publish === false && rv.gateVisualReview({ verdict: { ...v, verdict: 'fail' }, signOffs: [s], reviewerAllowlist: allow }).publish === false, 'gateVisualReview fail-closed');
    let threw = false; try { rv.signReviewerVerdict(v, { reviewer }); } catch { threw = true; }
    assert(threw, 'signReviewerVerdict requires a private key');
    assert(rv.buildVerdictBusPost({ verdict: v, signOff: s }).type === 'RESOLVED' && rv.buildVerdictBusPost({ verdict: v, signOff: s }).task === 'extension-release-0.5.0' && rv.buildVerdictBusPost({ verdict: v, signOff: s }).priority === 'P2', 'buildVerdictBusPost: pass -> RESOLVED for the release task');
    assert(rv.buildVerdictBusPost({ verdict: { ...v, verdict: 'changes' } }).type === 'REFINE' && rv.buildVerdictBusPost({ verdict: { ...v, verdict: 'fail' } }).type === 'BLOCKED' && rv.buildVerdictBusPost(null).type === 'BLOCKED', 'buildVerdictBusPost: semantic type + fail-safe default');
    console.log('reviewer-verdict-media-coverage: PASS -- media/reviewerVerdict.mjs exercised across all branches');
  }

  {
    assert(ext.verdictsDir(join('g', 'r')).endsWith(join('handoff', 'verdicts')), 'verdictsDir is handoff/verdicts');
    const vt = join(tmpdir(), 'lba-test-verdict-target-xyz');
    rmSync(vt, { recursive: true, force: true });
    mkdirSync(join(vt, 'handoff'), { recursive: true });
    assert(ext.readReviewTarget(vt, '9.9.9').version === '9.9.9' && ext.readReviewTarget(vt, '9.9.9').commit === null, 'readReviewTarget defaults when the file is absent');
    writeFileSync(join(vt, 'handoff', 'review-target.json'), JSON.stringify({ component: 'extension', version: '0.5.0', commit: 'c'.repeat(40), vsixSha256: 'd'.repeat(64), evidence: [{ kind: 'capture', ref: 'run-x' }] }));
    const t1 = ext.readReviewTarget(vt, '9.9.9');
    assert(t1.version === '0.5.0' && t1.commit.length === 40 && t1.evidence.length === 1, 'readReviewTarget reads the target file');
    writeFileSync(join(vt, 'handoff', 'review-target.json'), '{bad');
    assert(ext.readReviewTarget(vt, '9.9.9').version === '9.9.9', 'readReviewTarget tolerates bad json');
    const signed = ext.buildSignedVerdict(rv, { target: t1, verdict: 'pass', reviewer: 'rev@x', station: 'WINDOWS_VM', notes: 'ok', evidence: t1.evidence, privateKeyPem: rvKeys.privateKeyPem, renderedAt: 't' });
    assert(signed.verdict.verdict === 'pass' && signed.signOff.decision === 'approve', 'buildSignedVerdict builds + signs a verdict');
    let threw = false; try { ext.buildSignedVerdict(rv, { target: { version: '' }, verdict: 'pass', reviewer: 'r', station: 'WINDOWS_VM', notes: '', evidence: [], privateKeyPem: rvKeys.privateKeyPem, renderedAt: 't' }); } catch { threw = true; }
    assert(threw, 'buildSignedVerdict throws on an invalid verdict');
    // LBA-REQ-066 (off-Discussions step 7, net-only): busSendArgs builds the `lbabus net send` argv for the verdict over TCP.
    const bs = ext.busSendArgs({ type: 'RESOLVED', task: 'extension-release-0.5.0' }, '/tmp/v.json', '10.0.2.2');
    assert(bs[0] === 'net' && bs[1] === 'send' && bs.includes('--hosts') && bs.includes('10.0.2.2') && bs.includes('--type') && bs.includes('RESOLVED') && bs.includes('--task') && bs.includes('extension-release-0.5.0') && bs.includes('--message-file') && bs.includes('/tmp/v.json'), 'busSendArgs builds the lbabus net send argv');
    const bsNoPeer = ext.busSendArgs({ type: 'BLOCKED', task: 't' }, '/tmp/v.json', '');
    assert(!bsNoPeer.includes('--hosts') && bsNoPeer.includes('--skip-if-no-peer'), 'busSendArgs uses --skip-if-no-peer (graceful no-op) when no peer is configured');
    assert(typeof ext.busPostArgs === 'undefined', 'the Discussion busPostArgs builder is removed (net-only)');
    rmSync(vt, { recursive: true, force: true });
    console.log('reviewer-verdict-helpers: PASS -- verdictsDir + readReviewTarget + buildSignedVerdict + busSendArgs (net-only)');
  }

  {
    const savedInfo = mockVscode.window.showInformationMessage;
    const savedInput = mockVscode.window.showInputBox;
    const savedCfg = mockVscode.workspace.getConfiguration;
    const render = registered.find((r) => r.id === 'labviewBenchmarkActor.renderReviewerVerdict').handler;
    const reviewer = 'reviewer@vm';
    const keyFile = join(tmpdir(), 'lba-test-reviewer-key-xyz.pem');
    writeFileSync(keyFile, rvKeys.privateKeyPem);

    // (1) no reviewerId/keyPath configured -> warns, no verdict.
    warnMessages.length = 0;
    await render();
    assert(warnMessages.some((m) => /reviewerId/.test(m)), 'renderReviewerVerdict warns without config');

    // (2) configured but the key path is missing -> errors.
    errorMessages.length = 0;
    mockVscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'reviewerId' ? reviewer : k === 'reviewerKeyPath' ? join(tmpdir(), 'lba-no-such-key-xyz.pem') : d) });
    await render();
    assert(errorMessages.some((m) => /key not found/i.test(m)), 'renderReviewerVerdict errors on a missing key');

    // (3) configured + a Pass choice + notes -> a signed verdict written that verifies against the enrolled key.
    mockVscode.workspace.getConfiguration = () => ({ get: (k, d) => (k === 'reviewerId' ? reviewer : k === 'reviewerKeyPath' ? keyFile : d) });
    mkdirSync(join(gsRoot, 'handoff'), { recursive: true });
    writeFileSync(join(gsRoot, 'handoff', 'review-target.json'), JSON.stringify({ component: 'extension', version: '0.5.0', commit: 'e'.repeat(40), vsixSha256: 'f'.repeat(64), evidence: [{ kind: 'capture', ref: 'run-live' }] }));
    mockVscode.window.showInformationMessage = () => 'Pass';
    mockVscode.window.showInputBox = async () => 'looks right end to end';
    const savedPath = process.env.PATH;
    process.env.PATH = ''; // the command's best-effort lbabus bus post must not shell a REAL post during the test
    await render();
    process.env.PATH = savedPath;
    const verdictFile = join(gsRoot, 'handoff', 'verdicts', 'extension-0.5.0.json');
    assert(existsSync(verdictFile), 'renderReviewerVerdict wrote the signed verdict');
    const rec = JSON.parse(readFileSync(verdictFile, 'utf8'));
    assert(rec.verdict.verdict === 'pass' && rec.verdict.target.version === '0.5.0' && rec.signOff.schema === rv.SIGNOFF_SCHEMA && rec.signOff.decision === 'approve' && rec.signOff.reviewer === reviewer, 'the signed verdict records pass + approve + the reviewer');
    assert(rv.verifyReviewerVerdict(rec.verdict, rec.signOff, { reviewerAllowlist: { [reviewer]: rvKeys.publicKeyPem } }).ok, 'the extension-signed verdict verifies against the enrolled key');

    // (4) a dismissed choice -> no throw.
    mockVscode.window.showInformationMessage = () => undefined;
    await render();

    mockVscode.window.showInformationMessage = savedInfo;
    mockVscode.window.showInputBox = savedInput;
    mockVscode.workspace.getConfiguration = savedCfg;
    rmSync(keyFile, { force: true });
    console.log('reviewer-verdict-command: PASS -- Render Reviewer Verdict -> Ed25519-signed verdict written + verifies');
  }
} finally {
  Module._load = originalLoad;
}

console.log(
  `extension-activation: PASS -- activate() registered ${registered.length} commands + ${registeredTools.length} LM tools ` +
    `(${registered.map((r) => r.id).join(', ')}); prerequisite-remediation surfaced; deactivate() clean.`
);
process.exit(0);
