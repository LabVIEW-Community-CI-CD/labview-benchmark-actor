// verify-boot-benchmark-vmware.mjs — CI proof of the WIN/VMware capture backend (no VM / no VNC server).
//
// Mirrors verify-boot-benchmark.mjs's VBox-backend section for the VMware side: asserts the shared backend
// contract (backend/transport/probe/start via injected vmrun `exec`), the .vmx serial + VNC config helpers,
// the pure vmx upsert, and — the VMware-specific part — the minimal RFB (VNC) framebuffer grab decoded
// against a SCRIPTED mock socket (so the protocol + pixel decode are tested with no real VNC server).
//
//   node experiments/mprr-boot-benchmark/verify-boot-benchmark-vmware.mjs

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, rmSync } from 'node:fs';
import {
  createVmwareBackend, vmwareSerialConfigVmx, vmwareVncConfigVmx, upsertVmxConfig, grabVncFramebuffer,
} from './capture-backend-vmware.mjs';
import { decodePng } from '../manual-procedure-record/capture-adapter.mjs';

let passed = 0;
function ok(label) { passed += 1; console.log(`  ok  ${label}`); }

// --- a scripted RFB server over a mock socket (delivers bytes in chunks after listeners attach) -----------
function buildRfbServerBytes({ width, height, pixels }) {
  const pv = Buffer.from('RFB 003.008\n', 'latin1');       // ProtocolVersion
  const sec = Buffer.from([1, 1]);                          // 3.8 security: count=1, type None(1)
  const secResult = Buffer.from([0, 0, 0, 0]);             // SecurityResult OK
  const serverInit = Buffer.alloc(24);                     // ServerInit: w,h,pixelFormat(16),nameLen=0
  serverInit.writeUInt16BE(width, 0); serverInit.writeUInt16BE(height, 2); serverInit.writeUInt32BE(0, 20);
  const fbuHdr = Buffer.from([0, 0, 0, 1]);                // FramebufferUpdate: type0, pad, numRects=1
  const rectHdr = Buffer.alloc(12);
  rectHdr.writeUInt16BE(0, 0); rectHdr.writeUInt16BE(0, 2); rectHdr.writeUInt16BE(width, 4);
  rectHdr.writeUInt16BE(height, 6); rectHdr.writeInt32BE(0, 8); // Raw encoding
  return Buffer.concat([pv, sec, secResult, serverInit, fbuHdr, rectHdr, Buffer.from(pixels)]);
}

function mockVncSocket(serverBytes, { chunks = 3 } = {}) {
  const sock = new EventEmitter();
  sock.writes = [];
  sock.write = (b) => { sock.writes.push(Buffer.from(b)); return true; };
  sock.destroy = () => { sock.emit('close'); };
  setImmediate(() => {
    const size = Math.max(1, Math.ceil(serverBytes.length / chunks));
    let off = 0;
    const push = () => {
      if (off >= serverBytes.length) return;
      const end = Math.min(off + size, serverBytes.length);
      sock.emit('data', serverBytes.subarray(off, end));
      off = end;
      if (off < serverBytes.length) setImmediate(push);
    };
    push();
  });
  return sock;
}

// 2x2 framebuffer, my forced pixel format is bytes [R,G,B,pad]: red, green, blue, white.
const PIXELS_2x2 = [255, 0, 0, 0, /**/ 0, 255, 0, 0, /**/ 0, 0, 255, 0, /**/ 255, 255, 255, 0];
const EXPECT_RGBA = [255, 0, 0, 255, /**/ 0, 255, 0, 255, /**/ 0, 0, 255, 255, /**/ 255, 255, 255, 255];

console.log('vmware backend — contract + argv (injected exec)');
{
  const calls = [];
  const exec = (file, args) => {
    calls.push([file, ...args]);
    if (args.at(-1) === 'list') return { status: 0, stdout: 'Total running VMs: 1\nC:\\stage\\actor-golden\\actor-golden.vmx\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const be = createVmwareBackend({ vmx: 'C:\\stage\\actor-golden\\actor-golden.vmx', vncPort: 5901, exec });
  assert.equal(be.backend, 'vmware-vnc'); ok('backend id = vmware-vnc');
  assert.equal(be.transport, 'vnc://127.0.0.1:5901 framebuffer (RemoteDisplay.vnc)'); ok('transport declares the VNC grab');

  const p = be.probe();
  assert.deepEqual(p, { ok: true, state: 'running' });
  assert.deepEqual(calls.at(-1), ['vmrun', '-T', 'ws', 'list']); ok('probe -> vmrun list argv + running (vmx in list)');

  // a different vmx not in the running list -> stopped
  const beOff = createVmwareBackend({ vmx: 'C:\\other\\x.vmx', exec });
  assert.deepEqual(beOff.probe(), { ok: false, state: 'stopped' }); ok('probe -> stopped when vmx absent from list');

  const st = be.start();
  assert.equal(st.ok, true);
  assert.deepEqual(calls.at(-1), ['vmrun', '-T', 'ws', 'start', 'C:\\stage\\actor-golden\\actor-golden.vmx', 'gui']); ok('start -> gui default (WS25 nogui caveat)');
  be.start({ headless: true });
  assert.equal(calls.at(-1).at(-1), 'nogui'); ok('start({headless}) -> nogui');
}

console.log('vmware backend — capture failure surfaces (no throw)');
{
  const be = createVmwareBackend({ vmx: 'C:\\x.vmx', connect: () => { const s = new EventEmitter(); s.write = () => {}; s.destroy = () => {}; setImmediate(() => s.emit('error', new Error('ECONNREFUSED'))); return s; } });
  const r = await be.capture(join(tmpdir(), 'nope.png'));
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED|closed/); ok('capture connect error -> {ok:false}, no throw');
}

console.log('vmware .vmx config helpers');
{
  assert.deepEqual(vmwareSerialConfigVmx({ hostFile: 'C:\\stage\\serial0.out' }), [
    ['serial0.present', 'TRUE'],
    ['serial0.fileType', 'file'],
    ['serial0.fileName', 'C:\\stage\\serial0.out'],
    ['serial0.yieldOnMsrRead', 'TRUE'],
  ]); ok('vmwareSerialConfigVmx -> serial0 file sink (VMware analog of --uartmode1 file)');

  assert.deepEqual(vmwareVncConfigVmx({ port: 5901 }), [
    ['RemoteDisplay.vnc.enabled', 'TRUE'],
    ['RemoteDisplay.vnc.port', '5901'],
  ]); ok('vmwareVncConfigVmx -> enables the built-in VNC server (power-on framebuffer)');

  const vmx0 = 'displayName = "actor"\nserial0.present = "FALSE"\nmemsize = "4096"\n';
  const vmx1 = upsertVmxConfig(vmx0, [...vmwareSerialConfigVmx({ hostFile: '/tmp/s' }), ...vmwareVncConfigVmx({ port: 5901 })]);
  assert.match(vmx1, /serial0\.present = "TRUE"/); ok('upsertVmxConfig REPLACES an existing key (serial0.present FALSE->TRUE)');
  assert.equal((vmx1.match(/serial0\.present/g) || []).length, 1); ok('upsert does not duplicate the replaced key');
  assert.match(vmx1, /RemoteDisplay\.vnc\.enabled = "TRUE"/); ok('upsertVmxConfig APPENDS new keys');
  assert.match(vmx1, /memsize = "4096"/); ok('upsert preserves untouched keys');
}

console.log('vmware VNC grab — RFB decode against scripted mock server');
{
  const serverBytes = buildRfbServerBytes({ width: 2, height: 2, pixels: PIXELS_2x2 });
  const sock = mockVncSocket(serverBytes);
  const fb = await grabVncFramebuffer({ host: '127.0.0.1', port: 5901, connect: () => sock });
  assert.equal(fb.width, 2); assert.equal(fb.height, 2); ok('grab -> framebuffer dimensions from ServerInit');
  assert.deepEqual([...fb.rgba], EXPECT_RGBA); ok('grab -> Raw pixels decoded to RGBA (forced [R,G,B,pad] format)');

  // client-side RFB handshake writes, in order
  assert.equal(sock.writes.length, 6); ok('client emitted the 6 RFB messages');
  assert.ok(sock.writes[0].equals(Buffer.from('RFB 003.008\n', 'latin1'))); ok('client ProtocolVersion reply (clamped to 3.8)');
  assert.ok(sock.writes[1].equals(Buffer.from([1]))); ok('client chose None security (type 1)');
  assert.ok(sock.writes[4].equals(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0]))); ok('client SetEncodings -> Raw only');
  assert.ok(sock.writes[5].equals(Buffer.from([3, 0, 0, 0, 0, 0, 0, 2, 0, 2]))); ok('client FramebufferUpdateRequest (non-incremental, full 2x2)');
}

console.log('vmware backend — capture() writes a PNG that round-trips');
{
  const dest = join(tmpdir(), `bootbench-vmware-${process.pid}.png`);
  const be = createVmwareBackend({ vmx: 'C:\\x.vmx', vncPort: 5901, connect: () => mockVncSocket(buildRfbServerBytes({ width: 2, height: 2, pixels: PIXELS_2x2 })) });
  const r = await be.capture(dest);
  assert.deepEqual({ ok: r.ok, path: r.path }, { ok: true, path: dest }); ok('capture -> { ok:true, path }');
  const dec = decodePng(readFileSync(dest));
  assert.equal(dec.width, 2); assert.equal(dec.height, 2); ok('captured PNG decodes to 2x2');
  assert.deepEqual([...dec.rgba], EXPECT_RGBA); ok('captured PNG pixels match the framebuffer');
  rmSync(dest, { force: true });
}

console.log(`\nvmware boot-benchmark backend verify: ${passed}/${passed} checks passed`);
