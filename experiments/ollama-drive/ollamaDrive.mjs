// Ollama-drive relay PoC (RFC #19, LINUX slice) — wire-compatible with `lbabus net` (ADR-0003).
//
// A THIN relay (my Q1 answer): it does NOT model the ollama API as a fat verb. It carries a drive
// request in over the SAME ADR-0003 framing lbabus net uses (4-byte big-endian length + one
// `labview-benchmark-actor/bus-msg@1` JSON envelope per frame), forwards it to the host ollama HTTP
// endpoint, and streams the reply back as PROGRESS frames (one per NDJSON token, done:false) plus a
// terminal DONE frame (done:true, + metrics) — mapping 1:1 onto lbabus net's PROGRESS/DONE types.
//
// Two modes (self-contained PoC; no external deps, Node BCL only):
//   relay --port 11511 [--ollama 127.0.0.1:11434]   TCP relay server: net frame <-> ollama HTTP
//   drive --host 127.0.0.1 --port 11511 --model llama3.1:8b --prompt "..."   client: prompt -> stream
//
// The drive plane is a DISTINCT port/session from the comms bus (my Q4 answer). Binds loopback by
// default; set --host 0.0.0.0 (relay) to expose on the private Vagrant net for the VM (my Q5 answer:
// mirrors OLLAMA_HOST rebind, but at the relay so ollama itself can stay localhost-bound).

import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SCHEMA = 'labview-benchmark-actor/bus-msg@1';
const RUN0 = performance.now();
const MAX_FRAME = 1024 * 1024; // ADR-0003 1 MiB cap, fail-closed

// ---- ADR-0003 framing (4-byte BE length prefix + UTF-8 JSON envelope) ---------------------------
function encodeFrame(envelope) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (json.length === 0 || json.length > MAX_FRAME) {
    throw new Error(`bus frame ${json.length} bytes out of range (1..${MAX_FRAME})`);
  }
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json]);
}

// Stateful decoder: feed chunks, get complete envelopes.
function createFrameDecoder(onEnvelope, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const length = buf.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME) {
        onError(new Error(`frame length ${length} out of range — fail closed`));
        return;
      }
      if (buf.length < 4 + length) return;
      const json = buf.subarray(4, 4 + length);
      buf = buf.subarray(4 + length);
      try {
        onEnvelope(JSON.parse(json.toString('utf8')));
      } catch (e) {
        onError(new Error(`frame JSON parse: ${e.message}`));
        return;
      }
    }
  };
}

function envelope(senderId, sessionId, seq, type, task, payload, ackOf) {
  return {
    schema: SCHEMA,
    sessionId,
    senderId,
    seq,
    ts: { wall: new Date().toISOString(), run: Math.round(performance.now() - RUN0) },
    type,
    task,
    payload,
    ackOf: ackOf ?? null,
  };
}

// ---- relay: net frame <-> ollama HTTP -----------------------------------------------------------
function runRelay(args) {
  const port = Number(args.port ?? 11511);
  const bindHost = args.host ?? '127.0.0.1';
  const [ollamaHost, ollamaPort] = (args.ollama ?? '127.0.0.1:11434').split(':');

  const server = net.createServer((sock) => {
    const remote = `${sock.remoteAddress}:${sock.remotePort}`;
    const session = crypto.randomUUID();
    let seq = 0;
    const send = (type, payload, ackOf) =>
      sock.write(encodeFrame(envelope('HOST-RELAY', session, seq++, type, 'ollama-drive', payload, ackOf)));

    const decode = createFrameDecoder(
      (env) => {
        // Accept a drive request: any envelope whose task is ollama-drive with a payload {model,prompt}.
        if (env.task !== 'ollama-drive' || !env.payload || typeof env.payload.prompt !== 'string') {
          send('NOTE', { error: 'expected task=ollama-drive with payload {model,prompt}' }, env.seq);
          return;
        }
        const { model = 'llama3.1:8b', prompt } = env.payload;
        console.error(`[relay] ${remote} drive model=${model} prompt=${JSON.stringify(prompt).slice(0, 60)}`);
        driveOllama(ollamaHost, Number(ollamaPort), model, prompt, send, env.seq);
      },
      (err) => {
        console.error(`[relay] framing error from ${remote}: ${err.message}`);
        sock.destroy();
      },
    );

    sock.on('data', decode);
    sock.on('error', (e) => console.error(`[relay] socket ${remote}: ${e.message}`));
  });

  server.listen(port, bindHost, () =>
    console.error(`[relay] ollama-drive relay on ${bindHost}:${port} -> ollama ${ollamaHost}:${ollamaPort} (ADR-0003 frames)`));
}

// POST /api/generate (stream) and pump NDJSON tokens back as PROGRESS frames + a terminal DONE.
function driveOllama(host, port, model, prompt, send, ackOf) {
  const body = JSON.stringify({ model, prompt, stream: true });
  const req = http.request(
    { host, port, path: '/api/generate', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
    (res) => {
      let acc = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        acc += chunk;
        let nl;
        while ((nl = acc.indexOf('\n')) >= 0) {
          const line = acc.slice(0, nl).trim();
          acc = acc.slice(nl + 1);
          if (!line) continue;
          let obj;
          try { obj = JSON.parse(line); } catch { continue; }
          if (obj.done) {
            send('DONE', { done: true, model, total_duration: obj.total_duration, eval_count: obj.eval_count }, ackOf);
          } else if (typeof obj.response === 'string') {
            send('PROGRESS', { response: obj.response, done: false }, ackOf);
          }
        }
      });
      res.on('end', () => { if (acc.trim()) { /* trailing */ } });
    },
  );
  req.on('error', (e) => send('DONE', { done: true, error: `ollama unreachable: ${e.message}` }, ackOf));
  req.write(body);
  req.end();
}

// ---- drive: client that sends a prompt and prints the streamed completion -----------------------
function runDrive(args) {
  const host = args.host ?? '127.0.0.1';
  const port = Number(args.port ?? 11511);
  const model = args.model ?? 'llama3.1:8b';
  const prompt = args.prompt ?? 'Reply with exactly the token OLLAMA_DRIVE_OK and nothing else.';
  const session = crypto.randomUUID();

  const sock = net.createConnection({ host, port }, () => {
    sock.write(encodeFrame(envelope('VM-AGENT', session, 0, 'CLAIM', 'ollama-drive', { model, prompt, stream: true })));
  });

  let tokens = 0;
  const started = performance.now();
  const decode = createFrameDecoder(
    (env) => {
      if (env.type === 'PROGRESS' && env.payload?.response !== undefined) {
        process.stdout.write(env.payload.response);
        tokens++;
      } else if (env.type === 'DONE') {
        const ms = Math.round(performance.now() - started);
        if (env.payload?.error) {
          process.stderr.write(`\n[drive] ERROR: ${env.payload.error}\n`);
          sock.end();
          process.exit(1);
        }
        process.stdout.write('\n');
        console.error(`[drive] done: ${tokens} token-frames in ${ms} ms (eval_count=${env.payload?.eval_count ?? '?'})`);
        sock.end();
        process.exit(0);
      } else if (env.type === 'NOTE' && env.payload?.error) {
        process.stderr.write(`\n[drive] relay rejected: ${env.payload.error}\n`);
        sock.end();
        process.exit(2);
      }
    },
    (err) => { console.error(`[drive] framing error: ${err.message}`); process.exit(3); },
  );
  sock.on('data', decode);
  sock.on('error', (e) => { console.error(`[drive] connect ${host}:${port}: ${e.message}`); process.exit(4); });
}

// ---- arg parse + dispatch -----------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const k = argv[i].slice(2);
      a[k] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
    }
  }
  return a;
}

const [mode, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
if (mode === 'relay') runRelay(args);
else if (mode === 'drive') runDrive(args);
else {
  console.error('usage: node ollamaDrive.mjs relay --port 11511 [--host 127.0.0.1] [--ollama 127.0.0.1:11434]');
  console.error('       node ollamaDrive.mjs drive --host 127.0.0.1 --port 11511 --model llama3.1:8b --prompt "..."');
  process.exit(1);
}
