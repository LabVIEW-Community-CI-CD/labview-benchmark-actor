// Host-side READ-ONLY mesh monitor + live dashboard (viewers 2 + 3).
//
// Reads ../mesh-actors.csv, then for each actor:
//   - binds the shared UDP presence port and counts/timestamps presence beacons per source IP (observer);
//   - periodically TCP-probes the lbabus-net bus port (connect-only reachability, never sends a bus message);
// and renders a live per-actor table. It NEVER posts to the bus — pure observation.
//
// Host prerequisite: an IP on the mesh subnet (the mesh runs on VMware vmnet2; add 192.168.56.1/24 to
// "VMware Network Adapter VMnet2" so the host can probe + receive). The tool warns if it can't bind.
//
//   node cleanroom/ubuntu-labview/mesh/viewers/mesh-monitor.mjs [--once]

import dgram from 'node:dgram';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = join(here, '..', '..', 'mesh-actors.csv');

function parseCsv(text) {
  const [head, ...rows] = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  const cols = head.split(',');
  return rows.map((r) => {
    const v = r.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, v[i]]));
  });
}

let actors;
try {
  actors = parseCsv(readFileSync(csvPath, 'utf8')).filter((a) => a.role === 'mesh');
} catch (e) {
  console.error(`mesh-monitor: cannot read ${csvPath}: ${e.message}`);
  process.exit(1);
}
if (actors.length === 0) {
  console.error('mesh-monitor: no role=mesh rows in mesh-actors.csv');
  process.exit(1);
}

// Per-actor live state keyed by ip.
const state = new Map();
for (const a of actors) {
  state.set(a.ip, { ...a, busOpen: null, lastPresence: 0, beacons: 0, lastMsg: '' });
}

// One UDP listener per distinct presence port (lbabus net beacon uses 7421).
const udpPorts = [...new Set(actors.map((a) => Number(a.udp_port)))];
for (const port of udpPorts) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (buf, rinfo) => {
    const st = state.get(rinfo.address);
    if (st) {
      st.lastPresence = Date.now();
      st.beacons += 1;
      st.lastMsg = buf.toString('utf8').slice(0, 40).replace(/\s+/g, ' ');
    }
  });
  sock.on('error', (err) => {
    console.error(`mesh-monitor: UDP bind :${port} failed (${err.message}). ` +
      'Is the host on the mesh subnet? (add 192.168.56.1/24 to VMware vmnet2)');
  });
  sock.bind(port, '0.0.0.0');
}

// TCP connect-only probe of the bus port (reachability; never writes to the socket).
function probeBus(a) {
  return new Promise((resolve) => {
    const s = net.connect({ host: a.ip, port: Number(a.tcp_port) });
    let done = false;
    const finish = (open) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(open); } };
    s.setTimeout(800);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

function render() {
  const now = Date.now();
  const lines = [];
  lines.push('=== lbabus-net mesh monitor (read-only) ===  ' + new Date().toISOString());
  lines.push('ACTOR    IP               BUS(tcp)   PRESENCE(udp)      BEACONS  LAST');
  for (const st of state.values()) {
    const bus = st.busOpen === null ? '   ?   ' : st.busOpen ? ' OPEN  ' : ' closed';
    const age = st.lastPresence ? `${Math.round((now - st.lastPresence) / 1000)}s ago` : 'never';
    lines.push(
      `${(st.hostname || st.actor_id).padEnd(8)} ${String(st.ip).padEnd(16)} ${bus.padEnd(10)} ` +
      `${age.padEnd(16)} ${String(st.beacons).padStart(7)}  ${st.lastMsg}`,
    );
  }
  lines.push('');
  lines.push('(read-only observer: TCP is connect-only, UDP is passive receive; never posts to the bus)');
  process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n') + '\n');
}

async function tick() {
  await Promise.all([...state.values()].map(async (st) => { st.busOpen = await probeBus(st); }));
  render();
}

const once = process.argv.includes('--once');
await tick();
if (once) {
  process.exit(0);
}
const timer = setInterval(tick, 1500);
process.on('SIGINT', () => { clearInterval(timer); process.stdout.write('\nmesh-monitor: stopped.\n'); process.exit(0); });
