#!/usr/bin/env node
// Maintainer activation test for the labview-benchmark-actor extension (LBA-REQ-001): mock the `vscode`
// module, load the COMPILED extension, and assert activate() registers its full command surface and that
// deactivate() is callable -- proving the extension activates without a real VS Code host or a display.
// Run after `npm run compile` (needs out/extension.js). A re-runnable proof; the full install-activation on
// a published .vsix (Codespace / golden VM) is the maintainer step.
//
// Usage: npm test   (== npm run compile && node test/extension-activation.mjs)

import Module, { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const compiled = join(here, '..', 'out', 'extension.js');
if (!existsSync(compiled)) {
  console.error('out/extension.js not found -- run `npm run compile` first.');
  process.exit(1);
}

// Mock the `vscode` module (host-provided at runtime; unavailable in plain node).
const registered = [];
const panels = [];
const errorMessages = [];
const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInputBox: async () => undefined,
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
          asWebviewUri: (u) => ({ toString: () => `vscode-resource://${u && u.path ? u.path : u}` }),
          cspSource: 'vscode-webview:',
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
    joinPath: (base, ...parts) => ({ path: [base && base.path ? base.path : '', ...parts].join('/') }),
    parse: (s) => ({ toString: () => s, path: s, scheme: String(s).split(':')[0] }),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.push({ id, handler });
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    workspaceFolders: [{ uri: { path: '/ws' } }],
    fs: {
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'FileNotFound' });
      },
      readFile: async () => Buffer.from(''),
      writeFile: async () => undefined,
    },
    openTextDocument: async () => ({}),
  },
  languages: { setTextDocumentLanguage: async (doc) => doc },
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
  ext.activate({ subscriptions, extensionUri: { path: '/ext' }, extension: { packageJSON: { version: '0.1.0' } } });

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

  ext.deactivate(); // must not throw
} finally {
  Module._load = originalLoad;
}

console.log(
  `extension-activation: PASS -- activate() registered ${registered.length} commands ` +
    `(${registered.map((r) => r.id).join(', ')}); prerequisite-remediation surfaced; deactivate() clean.`
);
process.exit(0);
