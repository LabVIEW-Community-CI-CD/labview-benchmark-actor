// Shared ADR-0003 bus framing (4-byte big-endian length prefix + one `labview-benchmark-actor/bus-msg@1`
// JSON envelope per frame, 1 MiB cap), factored so the host coordinator (encodes a CLAIM) and the cleanroom
// worker (decodes the CLAIM, encodes an ACK) speak the SAME wire `lbabus net` does. Kept dependency-free.
import net from 'node:net';
import { performance } from 'node:perf_hooks';

export const BUS_SCHEMA = 'labview-benchmark-actor/bus-msg@1';
export const MAX_FRAME = 1024 * 1024; // ADR-0003 1 MiB cap, fail-closed
const RUN0 = performance.now();

export function encodeFrame(envelope) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  if (json.length === 0 || json.length > MAX_FRAME) throw new Error(`bus frame ${json.length} bytes out of range (1..${MAX_FRAME})`);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length, 0);
  return Buffer.concat([len, json]);
}

// Stateful decoder: feed socket chunks, get complete envelopes. Fails closed on a bad length/JSON.
export function createFrameDecoder(onEnvelope, onError) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const length = buf.readUInt32BE(0);
      if (length === 0 || length > MAX_FRAME) { onError(new Error(`frame length ${length} out of range -- fail closed`)); return; }
      if (buf.length < 4 + length) return;
      const json = buf.subarray(4, 4 + length);
      buf = buf.subarray(4 + length);
      try { onEnvelope(JSON.parse(json.toString('utf8'))); }
      catch (e) { onError(new Error(`frame JSON parse: ${e.message}`)); return; }
    }
  };
}

export function makeEnvelope({ senderId, sessionId = 'uplift', seq = 0, type, task = null, payload = null, ackOf = null }) {
  return {
    schema: BUS_SCHEMA, sessionId, senderId, seq,
    ts: { wall: new Date().toISOString(), run: Math.round(performance.now() - RUN0) },
    type, task, payload, ackOf,
  };
}

// Connect, write one framed envelope, and close. Best-effort: resolves {sent:false,error} instead of throwing.
export function sendFrame({ host = '127.0.0.1', port, envelope, timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    let frame;
    try { frame = encodeFrame(envelope); } catch (e) { resolve({ sent: false, error: e.message }); return; }
    const sock = net.connect({ host, port }, () => sock.write(frame, () => sock.end()));
    sock.setTimeout(timeoutMs, () => sock.destroy(new Error('sendFrame timeout')));
    sock.on('close', () => resolve({ sent: true, host, port }));
    sock.on('error', (e) => resolve({ sent: false, error: e.message }));
  });
}
