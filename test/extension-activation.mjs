#!/usr/bin/env node
// Maintainer activation test for the labview-benchmark-actor extension (LBA-REQ-001): mock the `vscode`
// module, load the COMPILED extension, and assert activate() registers its full command surface and that
// deactivate() is callable -- proving the extension activates without a real VS Code host or a display.
// Run after `npm run compile` (needs out/extension.js). A re-runnable proof; the full install-activation on
// a published .vsix (Codespace / golden VM) is the maintainer step.
//
// Usage: npm test   (== npm run compile && node test/extension-activation.mjs)

import Module, { createRequire } from 'node:module';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
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
let agentsContentProvider = null;
const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
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
      return infoResponseQueue.length ? infoResponseQueue.shift() : undefined;
    },
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
      return undefined;
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
  workspace: {
    registerTextDocumentContentProvider: (_scheme, provider) => {
      agentsContentProvider = provider;
      return { dispose() {} };
    },
    getConfiguration: () => ({ get: (_key, dflt) => dflt }),
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
const childProcessMock = {
  execFile: (_file, _args, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    callback(Object.assign(new Error('spawn lbabus ENOENT'), { code: 'ENOENT' }));
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
  // a launch-capture record; samplerScript emits the PowerShell CIM sampler.
  {
    const capBuilder = await import(pathToFileURL(join(repoRoot, 'media', 'launch-capture.mjs')).href);
    const capDir = join(tmpdir(), 'lba-test-capture-assemble-xyz');
    rmSync(capDir, { recursive: true, force: true });
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'frame-00000.png'), 'x'.repeat(120));
    writeFileSync(join(capDir, 'frame-00001.png'), 'x'.repeat(140));
    // resources.jsonl: two valid samples + a blank line + a partial (unparseable) line the assembler must skip.
    writeFileSync(
      join(capDir, 'resources.jsonl'),
      '{"ms":1,"cpuPct":10,"ramMb":2000,"diskPct":1}\n\n{bad partial line\n{"ms":2,"cpuPct":12,"ramMb":2010,"diskPct":2}\n'
    );
    const rec = ext.assembleCaptureFromDir(capDir, capBuilder);
    assert(Array.isArray(rec.frames) && rec.frames.length === 2, `assembleCaptureFromDir builds a 2-frame record, got ${rec.frames && rec.frames.length}`);
    assert(existsSync(join(capDir, 'capture.json')), 'assembleCaptureFromDir writes capture.json alongside the frames');

    // empty dir -> fails closed (no frames were captured).
    const capEmpty = join(tmpdir(), 'lba-test-capture-empty-xyz');
    rmSync(capEmpty, { recursive: true, force: true });
    mkdirSync(capEmpty, { recursive: true });
    let capThrew = false;
    try { ext.assembleCaptureFromDir(capEmpty, capBuilder); } catch { capThrew = true; }
    assert(capThrew, 'assembleCaptureFromDir throws when no frames were captured');
    rmSync(capDir, { recursive: true, force: true });
    rmSync(capEmpty, { recursive: true, force: true });

    // CIM sampler script: the CPU/RAM/disk CIM queries + a single-quote-escaped out path (no injection).
    const script = ext.samplerScript("C:\\lba\\res'ources.jsonl");
    assert(
      /Win32_PerfFormattedData_PerfOS_Processor/.test(script) && /TotalVisibleMemorySize/.test(script) && /PerfDisk_PhysicalDisk/.test(script),
      'samplerScript emits the CPU + RAM + disk CIM queries'
    );
    assert(/res''ources\.jsonl/.test(script), 'samplerScript single-quote-escapes the out path (no injection)');
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

  // captureLaunch on a host without LabVIEW.exe (the Linux test host) -> the "LabVIEW.exe not found" guard, and
  // it returns BEFORE any spawn (the ffmpeg/proc capture itself is cleanroom-gated + live-proven, never faked).
  const errsBeforeCapture = errorMessages.length;
  await registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunch').handler();
  assert(
    errorMessages.slice(errsBeforeCapture).some((m) => /LabVIEW\.exe not found/.test(m)),
    'captureLaunch surfaces the LabVIEW-not-found guard when no LabVIEW is configured'
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

  // Capture commands (LBA-REQ-009): on a host without LabVIEW the capture short-circuits at resolveLabview,
  // covering resolveFfmpeg + resolveLabview + captureCfg + the early guards. The ffmpeg/sampler spawn + the
  // frame correlator run on a Windows cleanroom (LabVIEW + ffmpeg), not in this unit test.
  await registered.find((r) => r.id === 'labviewBenchmarkActor.captureLaunch').handler();
  assert(
    errorMessages.some((m) => /LabVIEW\.exe not found/.test(m)),
    'captureLaunch reports missing LabVIEW (resolveLabview -> null) and returns before spawning ffmpeg'
  );
  await registered.find((r) => r.id === 'labviewBenchmarkActor.stopCapture').handler();
  assert(
    infoMessages.some((m) => /No LabVIEW capture is running/.test(m)),
    'stopCapture reports no active capture'
  );

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
  for (const id of ['openBenchmarkRun', 'openBenchmarkTrend', 'openCrossPlaneTrend', 'openResourceProfile', 'openCrossPlaneResource']) {
    await second.find((r) => r.id === `labviewBenchmarkActor.${id}`).handler();
  }
  assert(
    errorMessages.length >= errBefore + 5,
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
} finally {
  Module._load = originalLoad;
}

console.log(
  `extension-activation: PASS -- activate() registered ${registered.length} commands + ${registeredTools.length} LM tools ` +
    `(${registered.map((r) => r.id).join(', ')}); prerequisite-remediation surfaced; deactivate() clean.`
);
process.exit(0);
