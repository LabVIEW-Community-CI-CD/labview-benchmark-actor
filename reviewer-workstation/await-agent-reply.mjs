#!/usr/bin/env node
// await-agent-reply.mjs -- host-side STRUCTURED read-back for the host<->VM-agent closed loop (TCP, ADR-0003/0008).
//
// Closes the loop that drive-agent-chat.sh leaves open: after the host keyboard-injects a prompt into the
// reviewer VM's Copilot Chat, the VM agent reports its result back over `lbabus net` (a DONE frame). This
// script runs the host-side `lbabus net listen`, AWAITS the frame whose `task:` matches the correlation id,
// parses it into a structured reply, and (optionally) writes a receipt. Exit 0 iff a correlated frame of the
// expected --type arrived; non-zero on timeout or task mismatch (fail-closed correlation).
//
// This is the host-side structured consumer that `lbabus net listen` alone does not provide (it only prints
// TCP/UDP lines). No GitHub Discussion in the loop -- the read-back rides TCP only, per the operator directive
// to move coordination off GitHub Discussions onto the private lbabus net bus.
//
// Usage:
//   node reviewer-workstation/await-agent-reply.mjs --task loop-123 [--tcp 7420] [--timeout 300] \
//        [--type DONE] [--count 1] [--out receipt.json]
// Env:
//   LBABUS   path to the lbabus binary or a *.dll (default: `lbabus` on PATH). A *.dll is launched via `dotnet`
//            with DOTNET_ROLL_FORWARD=Major so a net8.0 build runs on a newer-only runtime.
//
// Prints the matched reply as one JSON line on stdout (so a driver can consume it). The listener's --echo ACK
// tells the VM agent the host received its report.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const a = { tcp: 7420, timeout: 300, type: 'DONE', count: 1, task: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case '--task': a.task = v; i += 1; break;
      case '--tcp': a.tcp = Number(v); i += 1; break;
      case '--timeout': a.timeout = Number(v); i += 1; break;
      case '--type': a.type = v; i += 1; break;
      case '--count': a.count = Number(v); i += 1; break;
      case '--out': a.out = v; i += 1; break;
      case '-h': case '--help': a.help = true; break;
      default: throw new Error(`await-agent-reply: unknown argument '${k}'`);
    }
  }
  return a;
}

// A rendered listener line, e.g.:
//   TCP 127.0.0.1:56192  [2026-08-03T10:26:20.612Z] VM-ACTOR #178 DONE task:loop-smoke — <payload>
// (BusWire.Render: `[ts] senderId #seq TYPE task:<task> ackOf:<n> — <payload>`, em dash U+2014 before payload.)
const LINE_RE = /^(TCP|UDP)\s+(\S+)\s+\[([^\]]+)\]\s+(\S+)\s+#(\S+)\s+(\S+)(?:\s+task:(\S+))?(?:\s+ackOf:(\S+))?(?:\s+\u2014\s+([\s\S]*))?$/;

export function parseLine(line) {
  const m = LINE_RE.exec(line.trim());
  if (!m) return null;
  return {
    transport: m[1], remote: m[2], ts: m[3], senderId: m[4],
    seq: m[5], type: m[6], task: m[7] ?? null, ackOf: m[8] ?? null, payload: m[9] ?? null,
  };
}

function resolveLbabus() {
  const lbabus = process.env.LBABUS || 'lbabus';
  if (lbabus.endsWith('.dll')) {
    return { cmd: 'dotnet', pre: [lbabus], env: { ...process.env, DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD || 'Major' } };
  }
  return { cmd: lbabus, pre: [], env: process.env };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.help) { console.log(readHelp()); return 0; }
  if (!a.task) { console.error('await-agent-reply: --task <id> is required'); return 2; }

  const { cmd, pre, env } = resolveLbabus();
  const args = [...pre, 'net', 'listen', '--tcp', String(a.tcp), '--echo', '--count', String(a.count), '--timeout', String(a.timeout)];
  const startedAt = new Date().toISOString();
  console.error(`[await-agent-reply] listening tcp=${a.tcp} awaiting type=${a.type} task=${a.task} timeout=${a.timeout}s`);

  const child = spawn(cmd, args, { env });
  const frames = [];
  let matched = null;
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      const f = parseLine(line);
      if (!f) continue;
      frames.push(f);
      if (!matched && f.type === a.type && f.task === a.task) matched = f;
    }
  });

  const code = await new Promise((res) => child.on('close', res));
  const resolvedAt = new Date().toISOString();

  const receipt = {
    schema: 'labview-benchmark-actor/closed-loop-readback@1',
    transport: 'lbabus net -- bus-msg@1, ADR-0003/0004 (TCP)',
    listenTcp: a.tcp,
    expected: { type: a.type, task: a.task },
    matched: matched !== null,
    reply: matched,
    framesHeard: frames.length,
    startedAt,
    resolvedAt,
    listenerExit: code,
    note: matched
      ? 'VM agent reply correlated by task id; loop closed over TCP (no GitHub Discussion).'
      : 'no correlated reply before the listener stopped (timeout or task mismatch) -- fail-closed.',
  };

  if (a.out) { writeFileSync(a.out, JSON.stringify(receipt, null, 2)); console.error(`[await-agent-reply] receipt -> ${a.out}`); }
  if (matched) { process.stdout.write(JSON.stringify(matched) + '\n'); return 0; }
  console.error(`[await-agent-reply] NO correlated ${a.type} for task ${a.task} (heard ${frames.length} frame(s))`);
  return 1;
}

function readHelp() {
  return 'await-agent-reply.mjs --task <id> [--tcp 7420] [--timeout 300] [--type DONE] [--count 1] [--out receipt.json]';
}

// Run as a CLI only when invoked directly; importing this module (e.g. the selftest) just gets the helpers.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().then((c) => process.exit(c)).catch((e) => { console.error(e.message); process.exit(3); });
}
