#!/usr/bin/env node
// server.mjs -- ACG grid MCP stdio server (ADR-0020, LBA-REQ-029). Reads newline-delimited JSON-RPC 2.0 messages
// from stdin, dispatches them through the grid tool surface, and writes responses to stdout. Dependency-free.
// This is the discoverable agent surface: `initialize` -> `tools/list` -> `tools/call` over the same MCP contract
// as the ADR-0012 server.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handleAcgGridMcpMessage } from './grid-tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let serverVersion = '0.0.0';
try {
  serverVersion = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')).version ?? '0.0.0';
} catch { /* default */ }

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
    return;
  }
  const response = handleAcgGridMcpMessage(message, { serverVersion });
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
