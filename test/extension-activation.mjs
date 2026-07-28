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
const mockVscode = {
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    showInputBox: async () => undefined,
    showErrorMessage: () => undefined,
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.push({ id, handler });
      return { dispose() {} };
    },
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  return request === 'vscode' ? mockVscode : originalLoad.call(this, request, parent, isMain);
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
  ext.activate({ subscriptions });

  const expected = [
    'labviewBenchmarkActor.showCapabilities',
    'labviewBenchmarkActor.pollBus',
    'labviewBenchmarkActor.postNote',
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

  ext.deactivate(); // must not throw
} finally {
  Module._load = originalLoad;
}

console.log(
  `extension-activation: PASS -- activate() registered ${registered.length} commands ` +
    `(${registered.map((r) => r.id).join(', ')}); deactivate() clean.`
);
process.exit(0);
