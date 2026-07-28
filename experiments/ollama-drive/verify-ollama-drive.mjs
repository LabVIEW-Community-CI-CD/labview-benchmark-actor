#!/usr/bin/env node
// Ollama-drive relay self-test (RFC #19, LINUX slice). Dependency-free ESM, no GPU / no real ollama.
//
// Re-runnable local proof for the ollama-drive relay + authz (PR #22): it stands up a MOCK ollama
// HTTP endpoint (a tiny node:http server that answers POST /api/generate with canned NDJSON tokens),
// spawns the REAL relay pointed at the mock, and drives the REAL client through four scenarios,
// asserting the wire behaviour end-to-end WITHOUT a GPU or a live model:
//
//   1. authorized drive (allowed model + correct token) streams the completion  -> exit 0
//   2. the same request actually reaches ollama (mock saw exactly one forward)
//   3. a bad token is rejected                                                   -> exit 2, never forwarded
//   4. a model outside the allow-list is rejected                               -> exit 2, never forwarded
//   5. an unconfigured relay (no token, no allow-list) is open by default        -> exit 0
//
// This lets either plane reproduce the #22 authz proof in CI / Codespaces (Linux), not just on the
// author's ollama box. Usage: node experiments/ollama-drive/verify-ollama-drive.mjs [--json]
// Exit 0 when every check passes, 1 otherwise.

import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const DRIVER = join(here, 'ollamaDrive.mjs');
const asJson = process.argv.slice(2).includes('--json');

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (ok) { pass++; } else { fail++; }
  if (!asJson) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Mock ollama: records each drive it is asked to run and streams a deterministic 3-token completion
// that spells OLLAMA_MOCK_OK, so the client's concatenated stdout is assertable.
const mockRequests = [];
function startMock() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/api/generate') { res.writeHead(404); res.end(); return; }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let reqObj = {};
        try { reqObj = JSON.parse(body); } catch { reqObj = {}; }
        mockRequests.push({ model: reqObj.model, prompt: reqObj.prompt });
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const tok of ['OLLAMA', '_MOCK', '_OK']) {
          res.write(JSON.stringify({ response: tok, done: false }) + '\n');
        }
        res.write(JSON.stringify({ done: true, total_duration: 1234567, eval_count: 3 }) + '\n');
        res.end();
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

function startRelay(port, extraArgs) {
  const proc = spawn(process.execPath, [DRIVER, 'relay', '--port', String(port), ...extraArgs],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Promise((resolve, reject) => {
    let settled = false;
    let err = '';
    const to = setTimeout(() => { if (!settled) { settled = true; reject(new Error('relay start timeout')); } }, 8000);
    proc.stderr.on('data', (c) => {
      err += c;
      if (!settled && err.includes(`on 127.0.0.1:${port}`)) { settled = true; clearTimeout(to); resolve(proc); }
    });
    proc.on('error', (e) => { if (!settled) { settled = true; clearTimeout(to); reject(e); } });
    proc.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(to); reject(new Error(`relay exited early code=${code}: ${err}`)); } });
  });
}

function drive(port, args, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [DRIVER, 'drive', '--port', String(port), ...args],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const to = setTimeout(() => proc.kill(), timeoutMs);
    proc.stdout.on('data', (c) => { out += c; });
    proc.stderr.on('data', (c) => { err += c; });
    proc.on('exit', (code) => { clearTimeout(to); resolve({ code, out, err }); });
  });
}

async function main() {
  const mock = await startMock();
  const mockPort = mock.address().port;
  const relayPort = await getFreePort();
  const openPort = await getFreePort();
  const authzRelay = await startRelay(relayPort,
    ['--ollama', `127.0.0.1:${mockPort}`, '--models', 'llama3.1:8b', '--token', 'verify-secret']);
  const openRelay = await startRelay(openPort, ['--ollama', `127.0.0.1:${mockPort}`]);

  try {
    // 1 + 2: authorized drive streams the completion AND actually reaches ollama.
    const before1 = mockRequests.length;
    const s1 = await drive(relayPort, ['--model', 'llama3.1:8b', '--token', 'verify-secret', '--prompt', 'say ok']);
    check('authorized-drive-streams-completion', s1.code === 0 && s1.out.includes('OLLAMA_MOCK_OK'),
      `code=${s1.code} out=${JSON.stringify(s1.out.trim())}`);
    const fwd = mockRequests.slice(before1);
    check('authorized-forwards-to-ollama', fwd.length === 1 && fwd[0].model === 'llama3.1:8b',
      `forwards=${fwd.length} model=${fwd[0]?.model ?? '?'}`);

    // 3: a bad token is rejected and never forwarded.
    const before2 = mockRequests.length;
    const s2 = await drive(relayPort, ['--model', 'llama3.1:8b', '--token', 'wrong-token', '--prompt', 'x']);
    check('bad-token-rejected', s2.code === 2 && /unauthorized/.test(s2.err),
      `code=${s2.code} err=${JSON.stringify(s2.err.trim())}`);
    check('bad-token-not-forwarded', mockRequests.length === before2,
      `forwards=${mockRequests.length - before2} (want 0)`);

    // 4: a model outside the allow-list is rejected and never forwarded.
    const before3 = mockRequests.length;
    const s3 = await drive(relayPort, ['--model', 'qwen2.5:14b', '--token', 'verify-secret', '--prompt', 'x']);
    check('disallowed-model-rejected', s3.code === 2 && /model not allowed/.test(s3.err),
      `code=${s3.code} err=${JSON.stringify(s3.err.trim())}`);
    check('disallowed-model-not-forwarded', mockRequests.length === before3,
      `forwards=${mockRequests.length - before3} (want 0)`);

    // 5: an unconfigured relay is open by default (loopback dev default).
    const s4 = await drive(openPort, ['--model', 'any-model', '--prompt', 'x']);
    check('open-relay-allows-when-unconfigured', s4.code === 0 && s4.out.includes('OLLAMA_MOCK_OK'),
      `code=${s4.code}`);
  } finally {
    authzRelay.kill();
    openRelay.kill();
    mock.close();
  }

  const total = pass + fail;
  if (asJson) {
    console.log(JSON.stringify({ pass, fail, total, results }, null, 2));
  } else {
    console.log('');
    console.log(fail === 0 ? `verify-ollama-drive: ALL PASS (${pass}/${total})` : `verify-ollama-drive: ${fail} FAILED (${pass}/${total})`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`verify-ollama-drive: ERROR ${e.stack ?? e}`); process.exit(1); });
