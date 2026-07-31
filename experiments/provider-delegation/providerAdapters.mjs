#!/usr/bin/env node
// Provider adapters: a provider-AGNOSTIC drive() seam so an "uplift domain" or documentation-drafting task
// can be delegated to Ollama, the Copilot CLI, Codex, or a deterministic mock -- behind the SAME contract
// the ollama-comparison harness already uses (`async driveFn(prompt) -> result`). The bus envelope, the
// task-spec, and the receipt never change when the provider changes; only the adapter does. This is the
// LINUX-plane slice of the "AI providers on cleanrooms delegate uplift/doc domains" idea: a cleanroom actor
// (which self-certifies via the gate suite) runs one of these adapters against its LOCAL provider.
//
// Contract:  async drive(prompt, opts) -> { provider, model, text, ms, ok, error }
//   - ok=false + error set on a provider/runtime failure (adapters NEVER throw for that -- the harness stays
//     up and writes a fail-closed receipt). Only programmer/validation errors throw.
//   - opts is provider-specific extra (model, sections, timeoutMs); an adapter ignores what it doesn't use.

import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';

// ---- Ollama: POST /api/generate (stream:false) -- the proven HTTP contract from experiments/ollama-drive.
export function ollamaAdapter({ host = process.env.OLLAMA_HOST_ADDR || '127.0.0.1', port = Number(process.env.OLLAMA_PORT || 11434) } = {}) {
  return async function drive(prompt, { model = 'llama3.1:8b', timeoutMs = 120000 } = {}) {
    const t0 = performance.now();
    const body = JSON.stringify({ model, prompt, stream: false });
    return await new Promise((resolve) => {
      const req = http.request(
        { host, port, path: '/api/generate', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
        (res) => {
          let acc = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { acc += c; });
          res.on('end', () => {
            const ms = Math.round(performance.now() - t0);
            try {
              const obj = JSON.parse(acc);
              resolve({ provider: 'ollama', model, text: String(obj.response ?? ''), ms, ok: true, error: null });
            } catch (e) {
              resolve({ provider: 'ollama', model, text: '', ms, ok: false, error: `parse: ${e.message}` });
            }
          });
        },
      );
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`ollama timeout ${timeoutMs}ms`)));
      req.on('error', (e) => resolve({ provider: 'ollama', model, text: '', ms: Math.round(performance.now() - t0), ok: false, error: e.message }));
      req.write(body); req.end();
    });
  };
}

// ---- Copilot CLI: shells the non-interactive Copilot CLI. Behind the seam; needs auth on the host/VM.
//      The default binary is the VS Code-bundled `copilot`; override the path with COPILOT_CLI. The
//      invocation is the assumed non-interactive form (`copilot -p <prompt>`) -- adjust per CLI version.
export function copilotCliAdapter({ bin = process.env.COPILOT_CLI || 'copilot' } = {}) {
  return async function drive(prompt, { timeoutMs = 120000 } = {}) {
    const t0 = performance.now();
    return await new Promise((resolve) => {
      execFile(bin, ['-p', prompt], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const ms = Math.round(performance.now() - t0);
        if (err) resolve({ provider: 'copilot-cli', model: bin, text: String(stdout || ''), ms, ok: false, error: String(stderr || err.message).slice(0, 400) });
        else resolve({ provider: 'copilot-cli', model: bin, text: String(stdout), ms, ok: true, error: null });
      });
    });
  };
}

// ---- Codex CLI: shells `codex exec <prompt>` (OpenAI Codex CLI). Behind the seam; not required for the
//      deterministic gate. Same contract, so the receipt is provider-independent. Override bin with CODEX_CLI.
export function codexAdapter({ bin = process.env.CODEX_CLI || 'codex' } = {}) {
  return async function drive(prompt, { timeoutMs = 120000 } = {}) {
    const t0 = performance.now();
    return await new Promise((resolve) => {
      execFile(bin, ['exec', prompt], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const ms = Math.round(performance.now() - t0);
        if (err) resolve({ provider: 'codex', model: bin, text: String(stdout || ''), ms, ok: false, error: String(stderr || err.message).slice(0, 400) });
        else resolve({ provider: 'codex', model: bin, text: String(stdout), ms, ok: true, error: null });
      });
    });
  };
}

// ---- Mock: deterministic, offline -- the self-test driver (mirrors ollama-comparison's mock injection).
//      Emits a structurally valid Markdown draft: a title + each requested `## <section>` + a deterministic
//      body + a brief-derived marker, so the acceptance gate passes for a well-formed task and the whole
//      harness is proven with NO GPU / NO network.
export function mockAdapter({ fill = 'This section is drafted deterministically for the self-test.' } = {}) {
  return async function drive(prompt, { model = 'mock', sections = [] } = {}) {
    let text = `# Draft\n\n${fill}\n`;
    for (const s of sections) text += `\n## ${s}\n\n${fill} (${s})\n`;
    text += `\n<!-- brief-hash:${simpleHash(prompt)} -->\n`;
    return { provider: 'mock', model, text, ms: 0, ok: true, error: null };
  };
}

function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h.toString(16);
}

// Factory: name -> adapter. `opts` is passed through to the adapter constructor.
export function selectAdapter(name, opts = {}) {
  switch (String(name || 'ollama').toLowerCase()) {
    case 'ollama': return ollamaAdapter(opts);
    case 'copilot-cli': case 'copilot': return copilotCliAdapter(opts);
    case 'codex': return codexAdapter(opts);
    case 'mock': return mockAdapter(opts);
    default: throw new Error(`unknown provider '${name}' (ollama|copilot-cli|codex|mock)`);
  }
}
