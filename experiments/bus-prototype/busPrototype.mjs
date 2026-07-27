#!/usr/bin/env node
// labview-benchmark-actor — comms-only inter-actor bus PROTOTYPE (Phase-2 de-risk).
//
// Grounds the net-new, least-proven piece of the spec: the TCP/UDP coordination
// bus. mprr has NO inter-actor bus (it coordinates via VirtualBox shared-folder
// + TDMS files), so ADR-0003/0004 are the only unproven transport in the design.
// This is a self-contained experiment (Node built-ins net + dgram only) that
// exercises, on 127.0.0.1, the exact contracts the ADRs claim:
//
//   ADR-0003  length-prefixed JSON over TCP (4-byte BE len + UTF-8 JSON),
//             bus-msg@1 envelope, leader-ordered append-log late-join
//             (HELLO -> SNAPSHOT + replay tail), check-before-publish
//             (optimistic concurrency on the log head via lastSeenSeq).
//   ADR-0004  UDP presence/liveness beacon (advisory; loss must not corrupt the
//             TCP-ordered state), dropped-peer detection.
//
// COMMS-ONLY (ADR-0005/0006, LBA-REQ-007/009/010): the bus carries inter-actor
// coordination messages only (CLAIM/ACK/HANDOFF/DONE/PROGRESS/NOTE) — never run
// data, frame metadata, or images. The entire mprr ring buffer stays VM-local.
//
// Run:  node busPrototype.mjs        (human-readable summary + JSON receipt)
// Exit: 0 = all assertions passed, 1 = one or more failed.

import net from 'node:net';
import dgram from 'node:dgram';

const SCHEMA = 'labview-benchmark-actor/bus-msg@1';
const MAX_FRAME = 1024 * 1024; // 1 MiB coordination cap (ADR-0003 §1)
const BEACON_MS = 40;          // fast cadence for the self-test (spec default 1 Hz)
const MISS_K = 3;              // miss K beacons => not-present (ADR-0004)
const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- framing: 4-byte big-endian length prefix + UTF-8 JSON ----------
function encodeFrame(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_FRAME) throw new Error(`frame ${json.length}B exceeds ${MAX_FRAME}B cap`);
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(json.length, 0);
  return Buffer.concat([head, json]);
}

function createFrameDecoder(onMessage, onError) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        // fail closed: an over-cap length is corrupt/hostile — surface + drop, do
        // not try to buffer it (ADR-0003 §6 degrade-safe).
        if (onError) onError(new Error(`oversize frame len=${len}`));
        buf = Buffer.alloc(0);
        return;
      }
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg = null;
      try { msg = JSON.parse(body.toString('utf8')); }
      catch { if (onError) onError(new Error('invalid JSON frame (dropped)')); continue; }
      onMessage(msg);
    }
  };
}

// ---------- Leader: TCP total order + append-log + UDP presence ----------
function createLeader({ host = '127.0.0.1' } = {}) {
  const sessionId = `sess-${Date.now().toString(36)}`;
  const log = [];                     // append-only ordered coordination log
  let globalSeq = 0;
  const claims = new Map();           // task -> owner senderId
  let handoffOwner = null;
  const lastSeqBySender = new Map();
  const conns = new Set();
  const peerUdp = new Map();          // senderId -> { address, port, lastBeacon }
  const events = [];                  // leader-side diagnostics
  let tcpPort = 0, udpPort = 0, beaconTimer = null, beaconsOn = true;

  const tcp = net.createServer((sock) => {
    conns.add(sock);
    const feed = createFrameDecoder(
      (msg) => onFrame(sock, msg),
      (err) => { events.push(`framing-error:${err.message}`); try { sock.write(encodeFrame({ schema: SCHEMA, type: 'ERROR', reason: err.message })); } catch { /* peer gone */ } }
    );
    sock.on('data', feed);
    sock.on('close', () => { conns.delete(sock); events.push('peer-tcp-closed'); });
    sock.on('error', () => { conns.delete(sock); });
  });

  function apply(m) {
    if (m.type === 'CLAIM' && m.task) claims.set(m.task, m.senderId);
    if (m.type === 'DONE' && m.task) claims.delete(m.task);
    if (m.type === 'HANDOFF') handoffOwner = (m.payload && m.payload.to) || m.senderId;
    if (typeof m.seq === 'number') lastSeqBySender.set(m.senderId, m.seq);
  }
  function snapshot() {
    return {
      schema: SCHEMA, type: 'SNAPSHOT', sessionId, globalSeqHead: globalSeq,
      claims: Object.fromEntries(claims), handoffOwner,
      lastSeqBySender: Object.fromEntries(lastSeqBySender)
    };
  }
  function onFrame(sock, msg) {
    if (msg.type === 'HELLO') {
      sock.write(encodeFrame(snapshot()));           // late-join: state snapshot,
      for (const e of log) sock.write(encodeFrame({ ...e, replay: true })); // then tail
      return;
    }
    // check-before-publish: the publisher's last-observed head must equal the
    // current head, else a message raced past it (optimistic concurrency).
    if (typeof msg.lastSeenSeq === 'number' && msg.lastSeenSeq !== globalSeq) {
      sock.write(encodeFrame({
        schema: SCHEMA, type: 'REJECT', reason: 'stale-lastSeenSeq',
        expectedHead: globalSeq, got: msg.lastSeenSeq, refSenderId: msg.senderId, refSeq: msg.seq
      }));
      return;
    }
    globalSeq += 1;
    const ordered = { ...msg, globalSeq };
    log.push(ordered);
    apply(ordered);
    for (const c of conns) { try { c.write(encodeFrame(ordered)); } catch { /* peer gone */ } }
  }

  const udp = dgram.createSocket('udp4');
  udp.on('message', (buf, rinfo) => {
    let m = null; try { m = JSON.parse(buf.toString('utf8')); } catch { return; }
    if (m && m.type === 'HEARTBEAT' && m.senderId) {
      peerUdp.set(m.senderId, { address: rinfo.address, port: rinfo.port, lastBeacon: Date.now() });
    }
  });
  function notPresent() {
    const now = Date.now(), out = [];
    for (const [sid, a] of peerUdp) if (now - a.lastBeacon > BEACON_MS * MISS_K) out.push(sid);
    return out;
  }
  function start() {
    return new Promise((resolve) => {
      tcp.listen(0, host, () => {
        tcpPort = tcp.address().port;
        udp.bind(0, host, () => {
          udpPort = udp.address().port;
          beaconTimer = setInterval(() => {
            if (!beaconsOn) return;
            const beacon = Buffer.from(JSON.stringify({ schema: SCHEMA, type: 'BEACON', sessionId, ts: Date.now(), leaderSeqHead: globalSeq }), 'utf8');
            for (const [, a] of peerUdp) { try { udp.send(beacon, a.port, a.address); } catch { /* peer gone */ } }
          }, BEACON_MS);
          resolve();
        });
      });
    });
  }
  function stop() {
    if (beaconTimer) clearInterval(beaconTimer);
    for (const c of conns) { try { c.destroy(); } catch { /* already gone */ } }
    return new Promise((resolve) => { udp.close(() => tcp.close(() => resolve())); });
  }
  return {
    start, stop, notPresent, sessionId,
    setBeacons: (on) => { beaconsOn = on; },
    get ports() { return { tcpPort, udpPort }; },
    get state() { return { globalSeq, claims: Object.fromEntries(claims), handoffOwner, logLen: log.length }; },
    get diag() { return { events: [...events], present: [...peerUdp.keys()], notPresent: notPresent() }; }
  };
}

// ---------- Peer: TCP client + UDP heartbeat ----------
function createPeer({ senderId, tcpPort, udpPort, host = '127.0.0.1' }) {
  const ordered = [];   // ordered (globalSeq-carrying) coordination messages
  const replayed = [];  // messages delivered during late-join replay
  const rejects = [];
  let snapshot = null, beacons = 0, lastSeenSeq = 0, seq = 0;
  const sock = new net.Socket();
  const udp = dgram.createSocket('udp4');
  const waiters = [];
  let hbTimer = null, hbOn = true;

  function notify() {
    for (const w of [...waiters]) if (w.pred()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
  }
  const feed = createFrameDecoder((msg) => {
    if (msg.type === 'SNAPSHOT') { snapshot = msg; lastSeenSeq = Math.max(lastSeenSeq, msg.globalSeqHead || 0); }
    else if (msg.type === 'REJECT') rejects.push(msg);
    else if (msg.replay) { replayed.push(msg); if (typeof msg.globalSeq === 'number') lastSeenSeq = Math.max(lastSeenSeq, msg.globalSeq); }
    else if (typeof msg.globalSeq === 'number') { ordered.push(msg); lastSeenSeq = Math.max(lastSeenSeq, msg.globalSeq); }
    notify();
  }, () => {});
  sock.on('data', feed);
  udp.on('message', (buf) => { try { if (JSON.parse(buf.toString('utf8')).type === 'BEACON') { beacons += 1; notify(); } } catch { /* ignore */ } });

  function connect() {
    return new Promise((resolve) => {
      sock.connect(tcpPort, host, () => {
        udp.bind(0, host, () => {
          hbTimer = setInterval(() => {
            if (!hbOn) return;
            const hb = Buffer.from(JSON.stringify({ schema: SCHEMA, type: 'HEARTBEAT', senderId, ts: Date.now() }), 'utf8');
            try { udp.send(hb, udpPort, host); } catch { /* leader gone */ }
          }, BEACON_MS);
          sock.write(encodeFrame({ schema: SCHEMA, senderId, type: 'HELLO', ts: { wall: Date.now(), run: 0 } }));
          resolve();
        });
      });
    });
  }
  // staleSeq lets the self-test force a check-before-publish violation.
  function publish(type, { task, payload, staleSeq } = {}) {
    seq += 1;
    const msg = { schema: SCHEMA, senderId, seq, type, ts: { wall: Date.now(), run: seq }, lastSeenSeq: staleSeq !== undefined ? staleSeq : lastSeenSeq };
    if (task !== undefined) msg.task = task;
    if (payload !== undefined) msg.payload = payload;
    sock.write(encodeFrame(msg));
    return msg;
  }
  function awaitUntil(pred, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      if (pred()) return resolve();
      const w = { pred, resolve };
      waiters.push(w);
      setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`await timeout (${senderId})`)); } }, timeoutMs);
    });
  }
  function close() { if (hbTimer) clearInterval(hbTimer); try { sock.destroy(); } catch { /* gone */ } return new Promise((r) => udp.close(() => r())); }
  return {
    senderId, connect, publish, awaitUntil, close,
    setHeartbeat: (on) => { hbOn = on; },
    get view() { return { ordered: [...ordered], replayed: [...replayed], snapshot, rejects: [...rejects], beacons, lastSeenSeq }; }
  };
}

// ---------- self-test ----------
async function main() {
  const results = [];
  const rec = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

  // 1. framing round-trip with an embedded newline/tab/quotes payload
  try {
    const orig = { schema: SCHEMA, senderId: 'x', seq: 1, type: 'NOTE', payload: { text: 'line1\nline2\twith\ttabs and "quotes" and \\backslash' } };
    let decoded = null;
    createFrameDecoder((m) => { decoded = m; }, null)(encodeFrame(orig));
    rec('framing-roundtrip-embedded-control-chars', JSON.stringify(decoded) === JSON.stringify(orig), { decoded });
  } catch (e) { rec('framing-roundtrip-embedded-control-chars', false, { error: e.message }); }

  // 2. near-cap encodes; oversize rejected on encode
  try {
    encodeFrame({ schema: SCHEMA, type: 'NOTE', payload: { blob: 'a'.repeat(MAX_FRAME - 256) } });
    let threw = false;
    try { encodeFrame({ payload: 'a'.repeat(MAX_FRAME + 16) }); } catch { threw = true; }
    rec('framing-oversize-rejected-on-encode', threw, {});
  } catch (e) { rec('framing-oversize-rejected-on-encode', false, { error: e.message }); }

  // 3. oversize length rejected on decode (fail closed, surfaced)
  try {
    let errd = false;
    const feed = createFrameDecoder(() => {}, () => { errd = true; });
    const head = Buffer.allocUnsafe(4); head.writeUInt32BE(MAX_FRAME + 5, 0);
    feed(Buffer.concat([head, Buffer.from('xx')]));
    rec('framing-oversize-rejected-on-decode', errd, {});
  } catch (e) { rec('framing-oversize-rejected-on-decode', false, { error: e.message }); }

  // 4. network exchange
  const leader = createLeader();
  await leader.start();
  const { tcpPort, udpPort } = leader.ports;
  const A = createPeer({ senderId: 'LINUX', tcpPort, udpPort });
  const B = createPeer({ senderId: 'WIN-VITLT', tcpPort, udpPort });
  await A.connect(); await B.connect();
  await A.awaitUntil(() => A.view.snapshot !== null);
  await B.awaitUntil(() => B.view.snapshot !== null);

  // ordered exchange: A CLAIM t1 -> B ACK -> A HANDOFF->B -> B DONE t1
  A.publish('CLAIM', { task: 't1' });
  await B.awaitUntil(() => B.view.ordered.length >= 1);
  B.publish('ACK', { task: 't1' });
  await A.awaitUntil(() => A.view.ordered.length >= 2);
  A.publish('HANDOFF', { task: 't1', payload: { to: 'WIN-VITLT' } });
  await B.awaitUntil(() => B.view.ordered.length >= 3);
  B.publish('DONE', { task: 't1' });
  await A.awaitUntil(() => A.view.ordered.length >= 4);
  await B.awaitUntil(() => B.view.ordered.length >= 4);

  const aSeqs = A.view.ordered.map((m) => m.globalSeq);
  const bSeqs = B.view.ordered.map((m) => m.globalSeq);
  rec('tcp-total-order-identical-across-peers',
    JSON.stringify(aSeqs) === '[1,2,3,4]' && JSON.stringify(bSeqs) === '[1,2,3,4]',
    { aSeqs, bSeqs, typesAtA: A.view.ordered.map((m) => m.type) });

  const ls = leader.state;
  rec('leader-derived-state-from-log', ls.handoffOwner === 'WIN-VITLT' && !('t1' in ls.claims) && ls.globalSeq === 4, ls);

  // 5. late-join: C connects after the exchange -> snapshot + replay reconstruct
  const C = createPeer({ senderId: 'LATE', tcpPort, udpPort });
  await C.connect();
  await C.awaitUntil(() => C.view.snapshot !== null && C.view.replayed.length >= 4);
  const cs = C.view.snapshot;
  rec('late-join-snapshot-plus-tail-reconstruct',
    cs.globalSeqHead === 4 && cs.handoffOwner === 'WIN-VITLT' && C.view.replayed.map((m) => m.globalSeq).join(',') === '1,2,3,4',
    { snapshot: cs, replayedSeqs: C.view.replayed.map((m) => m.globalSeq) });

  // 6. check-before-publish: stale lastSeenSeq -> REJECT; fresh -> accepted
  A.publish('NOTE', { payload: { note: 'stale' }, staleSeq: 0 });
  await A.awaitUntil(() => A.view.rejects.length >= 1);
  const rej = A.view.rejects[0];
  rec('check-before-publish-rejects-stale', rej && rej.reason === 'stale-lastSeenSeq' && rej.expectedHead === 4, { reject: rej });
  A.publish('NOTE', { payload: { note: 'fresh' } });
  await A.awaitUntil(() => A.view.ordered.some((m) => m.globalSeq === 5));
  rec('check-before-publish-accepts-fresh', A.view.ordered.some((m) => m.globalSeq === 5), {});

  // 7. UDP presence beacons flow (advisory)
  await A.awaitUntil(() => A.view.beacons >= 1).catch(() => {});
  rec('udp-presence-beacons-flow', (A.view.beacons + B.view.beacons) >= 1, { aBeacons: A.view.beacons, bBeacons: B.view.beacons });

  // 8. UDP loss does not corrupt TCP-ordered state (LBA-REQ-007.3)
  leader.setBeacons(false); A.setHeartbeat(false); B.setHeartbeat(false);
  const headBefore = leader.state.globalSeq;
  A.publish('NOTE', { payload: { note: 'after-total-udp-loss' } });
  await A.awaitUntil(() => A.view.ordered.some((m) => m.globalSeq === headBefore + 1));
  rec('udp-loss-does-not-corrupt-tcp-order', leader.state.globalSeq === headBefore + 1, { headBefore, headAfter: leader.state.globalSeq });

  // 9. presence timeout flags the peers that stopped heartbeating (A,B), not C
  await waitMs(BEACON_MS * (MISS_K + 3));
  const np = leader.notPresent();
  rec('presence-timeout-flags-silent-peers', np.includes('LINUX') && np.includes('WIN-VITLT') && !np.includes('LATE'), { notPresent: np });

  // 10. dropped TCP peer detected
  const before = leader.diag.events.filter((e) => e === 'peer-tcp-closed').length;
  await B.close();
  await waitMs(120);
  const after = leader.diag.events.filter((e) => e === 'peer-tcp-closed').length;
  rec('dropped-tcp-peer-detected', after > before, { closedEventsBefore: before, closedEventsAfter: after });

  await A.close(); await C.close(); await leader.stop();

  const passed = results.filter((r) => r.pass).length;
  const receipt = {
    schema: 'lba-bus-prototype-receipt@1', ranAt: new Date().toISOString(),
    node: process.version, sessionId: leader.sessionId,
    grounds: ['ADR-0003', 'ADR-0004', 'LBA-REQ-006', 'LBA-REQ-007', 'T-007'],
    frameCapBytes: MAX_FRAME, total: results.length, passed, failed: results.length - passed, results
  };
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
  console.log(`\n${passed}/${results.length} assertions passed`);
  console.log('---RECEIPT-JSON-START---');
  console.log(JSON.stringify(receipt, null, 2));
  console.log('---RECEIPT-JSON-END---');
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
