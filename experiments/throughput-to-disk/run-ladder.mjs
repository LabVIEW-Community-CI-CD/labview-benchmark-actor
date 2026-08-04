#!/usr/bin/env node
// run-ladder.mjs -- throughput-to-disk LADDER runner (no LabVIEW). Drives the C# `tpd` sink+source (Program.cs)
// over loopback at RUNGS of increasing disk load, takes N samples per rung, and emits a
// throughput-ladder-receipt@v1 with the per-rung MBps mean / stddev / coefficient-of-variation (CoV).
//
// This is the best-effort-reproducible benchmark the ACG witnesses run (replacing the deterministic
// screenshot-hash anchor): real disk benchmarks VARY run-to-run, so a witness records the DISTRIBUTION (not a
// single number), and the cross-witness corroboration (compare-ladders.mjs) verifies the rungs AGREE within a
// tolerance band and quantifies the spread. The timestamp differentiates each witness's run.
//
//   node run-ladder.mjs [--rungs 256M,512M,1G] [--frame 256K] [--samples 3] [--plane NAME]
//                       [--out-dir DIR] [--out receipt.json] [--transport tcp]
//
// Requires the .NET SDK (builds tpd on first run; roll-forward Major so the net8 tpd runs on a newer runtime).
// The sink writes to a REAL disk path (--out-dir, default $HOME) with --fsync-every 64M so the MBps reflects
// SUSTAINED throughput to disk, not the page cache. Dependency-free (Node builtins + the tpd binary).

import { spawn, execSync } from 'node:child_process';
import { existsSync, writeFileSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const TPD_DIR = here;
const TPD_BIN = join(TPD_DIR, 'bin', 'rel', 'tpd');
const ENV = { ...process.env, DOTNET_ROLL_FORWARD: process.env.DOTNET_ROLL_FORWARD || 'Major' };

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) o[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true;
  }
  return o;
}

// "256M" -> bytes (for labels + sorting); the tpd itself parses the K/M/G suffix.
function toBytes(s) {
  const m = /^([\d.]+)\s*([KMG]?)$/i.exec(String(s).trim());
  if (!m) throw new Error(`bad size ${s}`);
  const mul = { '': 1, K: 1 << 10, M: 1 << 20, G: 1 << 30 }[m[2].toUpperCase()];
  return Math.round(parseFloat(m[1]) * mul);
}

function ensureTpd() {
  if (existsSync(TPD_BIN)) return;
  process.stderr.write('[ladder] building tpd (dotnet build -c Release)...\n');
  execSync('dotnet build -c Release -o bin/rel', { cwd: TPD_DIR, stdio: 'inherit' });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// One rung sample: start the sink (writes received bytes to disk), start the source once the sink is listening,
// resolve with the sink's parsed RESULT. Fails closed if the sink never reports MBps.
function runSample({ bytes, frame, port, outFile, transport }) {
  return new Promise((resolve, reject) => {
    const sink = spawn(TPD_BIN, ['sink', '--transport', transport, '--port', String(port), '--bytes', bytes,
      '--out', outFile, '--fsync-every', '64M'], { env: ENV });
    let out = '', err = '', sourced = false;
    const startSource = () => {
      if (sourced) return; sourced = true;
      const src = spawn(TPD_BIN, ['source', '--transport', transport, '--host', '127.0.0.1', '--port', String(port),
        '--bytes', bytes, '--frame', frame], { env: ENV });
      src.on('error', reject);
    };
    sink.stdout.on('data', (d) => { out += d; });
    sink.stderr.on('data', (d) => { err += d; if (/listening|recv/.test(err)) startSource(); });
    sink.on('error', reject);
    const guard = setTimeout(startSource, 1500); // fallback if the listening cue was missed
    sink.on('close', (code) => {
      clearTimeout(guard);
      const mb = /MBps=([\d.]+)/.exec(out);
      if (!mb) return reject(new Error(`rung ${bytes}: no MBps (exit ${code}). err=${err.trim()}`));
      resolve({
        mbps: parseFloat(mb[1]),
        gbps: parseFloat((/GBps=([\d.]+)/.exec(out) || [])[1] || '0'),
        secs: parseFloat((/secs=([\d.]+)/.exec(out) || [])[1] || '0'),
      });
    });
  });
}

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const stddev = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(a.length - 1, 1)); };
const round = (x, n = 1) => Math.round(x * 10 ** n) / 10 ** n;

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const rungs = String(opt.rungs || '256M,512M,1G').split(',').map((s) => s.trim());
  const frame = String(opt.frame || '256K');
  const samples = Number(opt.samples || 3);
  const transport = String(opt.transport || 'tcp');
  const plane = String(opt.plane || process.env.LBA_PLANE || 'LOCAL');
  const outDir = String(opt['out-dir'] || homedir());
  const outFile = join(outDir, '.tpd-ladder-sink.bin');

  ensureTpd();
  const dotnetVer = (() => { try { return execSync('dotnet --version', { env: ENV }).toString().trim(); } catch { return null; } })();

  const rungReceipts = [];
  for (const rung of rungs) {
    const samplesMbps = [];
    let lastSecs = 0;
    for (let s = 0; s < samples; s += 1) {
      const port = await freePort();
      const r = await runSample({ bytes: rung, frame, port, outFile, transport });
      samplesMbps.push(r.mbps);
      lastSecs = r.secs;
      process.stderr.write(`[ladder] ${plane} rung ${rung} sample ${s + 1}/${samples}: ${r.mbps} MBps (${r.secs}s)\n`);
    }
    const m = mean(samplesMbps), sd = stddev(samplesMbps);
    rungReceipts.push({
      bytes: rung,
      bytesExact: toBytes(rung),
      frame,
      samplesMbps: samplesMbps.map((x) => round(x)),
      meanMbps: round(m),
      stddevMbps: round(sd, 2),
      covPct: round(m ? (sd / m) * 100 : 0, 2),
      meanSecs: round(lastSecs, 3),
    });
  }
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }

  const means = rungReceipts.map((r) => r.meanMbps);
  const receipt = {
    schema: 'labview-benchmark-actor/throughput-ladder-receipt@v1',
    tool: 'tpd (throughput-to-disk; socket -> disk, --fsync-every 64M; no LabVIEW)',
    plane,
    os: process.platform,
    host: hostname(),
    dotnet: dotnetVer,
    capturedAt: new Date().toISOString(),
    frame,
    samplesPerRung: samples,
    transport,
    rungs: rungReceipts,
    summary: {
      rungCount: rungReceipts.length,
      meanMbps: round(mean(means)),
      minMbps: round(Math.min(...means)),
      maxMbps: round(Math.max(...means)),
      maxRungCovPct: round(Math.max(...rungReceipts.map((r) => r.covPct)), 2),
    },
  };
  const json = JSON.stringify(receipt, null, 2) + '\n';
  if (typeof opt.out === 'string') { writeFileSync(opt.out, json); process.stderr.write(`[ladder] wrote ${opt.out}\n`); }
  else process.stdout.write(json);
}

main().catch((e) => { console.error('[ladder] FAILED:', e.message); process.exit(1); });
