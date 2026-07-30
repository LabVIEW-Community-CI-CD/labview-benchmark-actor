// capture-backend-vmware.mjs — the WIN/VMware capture backend for the boot-benchmark recorder.
//
// Mirror of capture-backend-vbox.mjs behind the SAME seam (backend, transport, vm, probe, capture, start),
// so the shared recorder core is provider-agnostic and only the capture backend differs — exactly how
// provision-guest.sh / provision-lbabus-fromsource.sh are shared and only the hypervisor step differs.
//
// WHY VNC (not `vmrun captureScreen`): `vmrun captureScreen` goes through VMware Tools in the guest and is
// login-gated, so it CANNOT see BIOS/GRUB/early-kernel/text-console — exactly the boot window we benchmark.
// VMware Workstation's built-in per-VM VNC server (RemoteDisplay.vnc.enabled in the .vmx) exposes the raw
// FRAMEBUFFER from power-on, headless, with no guest agent — the VMware analog of VBox `controlvm
// screenshotpng`. This backend grabs ONE framebuffer via a minimal RFB (VNC) client (node builtins only).
//
// SEAM NOTE: a VNC grab is inherently async (TCP), so capture() returns a Promise. VBox's capture() is sync,
// but `await <non-promise>` is a no-op, so a driver that does `await backend.capture(path)` works for BOTH
// backends. (Flagged to LINUX: the shared driver should await capture().)
//
// `exec` (vmrun) and `connect` (RFB socket) are injected so the argv + the RFB decode are unit-testable in
// CI with NO VM and NO real VNC server (see verify-boot-benchmark-vmware.mjs).

import net from 'node:net';
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { encodePng } from '../manual-procedure-record/capture-adapter.mjs';

/** Default exec: run a program, capture stdout; never throw (returns a status object). */
function defaultExec(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout?.toString?.() ?? '', stderr: err.stderr?.toString?.() ?? String(err) };
  }
}

/**
 * Create a VMware capture backend for one VM (identified by its .vmx path).
 * @param {{vmx:string, host?:string, vncPort?:number, vmrun?:string,
 *          exec?:(file:string,args:string[])=>{status:number,stdout:string,stderr:string},
 *          connect?:(opts:{host:string,port:number})=>import('node:net').Socket}} opts
 */
export function createVmwareBackend(opts) {
  if (!opts || !opts.vmx) throw new Error('createVmwareBackend: opts.vmx (path to the .vmx) is required');
  const vmx = opts.vmx;
  const host = opts.host ?? '127.0.0.1';
  const vncPort = opts.vncPort ?? 5900;
  const vmrun = opts.vmrun ?? 'vmrun';
  const exec = opts.exec ?? defaultExec;
  const connect = opts.connect ?? ((o) => net.connect(o));

  return {
    backend: 'vmware-vnc',
    transport: `vnc://${host}:${vncPort} framebuffer (RemoteDisplay.vnc)`,
    vm: vmx,

    /**
     * Is the VM currently running? VMware has no VMState query like VBox; `vmrun list` prints the running
     * .vmx paths, so probe() = "is my vmx in the running set?".
     */
    probe() {
      const r = exec(vmrun, ['-T', 'ws', 'list']);
      if (r.status !== 0) return { ok: false, state: null, error: r.stderr.trim() || `vmrun list exit ${r.status}` };
      const target = vmx.replace(/\\/g, '/').toLowerCase();
      const running = r.stdout.split(/\r?\n/).some((l) => l.replace(/\\/g, '/').toLowerCase().trim() === target);
      return { ok: running, state: running ? 'running' : 'stopped' };
    },

    /** Capture ONE framebuffer PNG to destPngPath via the VM's VNC server. Async ({ ok, path }). */
    async capture(destPngPath) {
      if (!destPngPath) throw new Error('vmware backend capture: destPngPath required');
      try {
        const fb = await grabVncFramebuffer({ host, port: vncPort, connect });
        writeFileSync(destPngPath, encodePng(fb.rgba, fb.width, fb.height));
        return { ok: true, path: destPngPath };
      } catch (err) {
        return { ok: false, path: destPngPath, error: String(err?.message ?? err) };
      }
    },

    /**
     * Start the VM. NOTE: on VMware Workstation 25 `vmrun start <vmx> nogui` errors ("unknown error"), so the
     * default is `gui` (the VNC grab is independent of the GUI window either way). Pass { headless:true } only
     * on hosts where nogui works.
     */
    start({ headless = false } = {}) {
      const r = exec(vmrun, ['-T', 'ws', 'start', vmx, headless ? 'nogui' : 'gui']);
      return { ok: r.status === 0, error: r.status === 0 ? undefined : (r.stderr.trim() || `vmrun start exit ${r.status}`) };
    },
  };
}

/**
 * The VMware serial-console config so the guest LBABENCH markers land in a HOST file the recorder tails live
 * — the VMware analog of VBox `--uartmode1 file`. VMware serial is configured via .vmx keys (applied while
 * powered off), so this returns the key/value pairs (mirrors vboxSerialConfigArgs returning argv). Apply with
 * upsertVmxConfig(), or feed to the Vagrant provider as v.vmx[...].
 * @param {{hostFile:string}} opts
 * @returns {[string,string][]}
 */
export function vmwareSerialConfigVmx({ hostFile }) {
  if (!hostFile) throw new Error('vmwareSerialConfigVmx: hostFile required');
  return [
    ['serial0.present', 'TRUE'],
    ['serial0.fileType', 'file'],
    ['serial0.fileName', hostFile],
    ['serial0.yieldOnMsrRead', 'TRUE'], // don't busy-spin the vCPU polling the (unread) UART
  ];
}

/**
 * The VMware VNC-console config so the recorder can grab the framebuffer from power-on. VBox needs none of
 * this (screenshotpng is native); VMware must enable its built-in VNC server in the .vmx. Password-less by
 * default (host-only/loopback benchmark); pass a password to set RemoteDisplay.vnc.key (DES-obfuscated key —
 * left to the driver; the grabber currently negotiates None auth).
 * @param {{port?:number, password?:string}} opts
 * @returns {[string,string][]}
 */
export function vmwareVncConfigVmx({ port = 5900, password } = {}) {
  const kv = [
    ['RemoteDisplay.vnc.enabled', 'TRUE'],
    ['RemoteDisplay.vnc.port', String(port)],
  ];
  if (password) kv.push(['RemoteDisplay.vnc.key', password]); // NOTE: VMware expects a DES-encoded key; driver's job
  return kv;
}

/**
 * Upsert .vmx key/value pairs into vmx text (pure; the fs wrapper is the driver's job). Existing keys are
 * replaced case-insensitively; new keys are appended. Returns the new text.
 * @param {string} vmxText
 * @param {[string,string][]} kvPairs
 */
export function upsertVmxConfig(vmxText, kvPairs) {
  let out = vmxText.replace(/\r\n/g, '\n');
  for (const [key, value] of kvPairs) {
    const line = `${key} = "${value}"`;
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'im');
    if (re.test(out)) out = out.replace(re, line);
    else out = out.replace(/\n?$/, `\n${line}\n`);
  }
  return out;
}

// --- minimal RFB (VNC) client: connect -> negotiate None auth -> force 32bpp -> grab ONE Raw framebuffer ---

/** Buffered exact-length reader over a socket. readN(n) resolves a Buffer of exactly n bytes (or rejects on EOF). */
function makeReader(sock) {
  let buf = Buffer.alloc(0);
  let waiter = null; // { n, resolve, reject }
  let error = null;
  let ended = false;
  const pump = () => {
    if (waiter && buf.length >= waiter.n) {
      const { n, resolve } = waiter; waiter = null;
      const out = buf.subarray(0, n); buf = buf.subarray(n);
      resolve(out); return;
    }
    if (waiter && (error || ended)) {
      const { reject } = waiter; waiter = null;
      reject(error ?? new Error('RFB: connection closed mid-stream'));
    }
  };
  sock.on('data', (d) => { buf = buf.length ? Buffer.concat([buf, d]) : d; pump(); });
  sock.on('error', (e) => { error = e; pump(); });
  sock.on('end', () => { ended = true; pump(); });
  sock.on('close', () => { ended = true; pump(); });
  return (n) => new Promise((resolve, reject) => {
    if (n === 0) return resolve(Buffer.alloc(0));
    waiter = { n, resolve, reject };
    pump();
  });
}

/**
 * Grab ONE framebuffer from a VNC server as RGBA. Negotiates RFB 3.3/3.7/3.8 with "None" security, forces a
 * 32bpp true-colour pixel format (bytes = [R,G,B,pad]) so decode is deterministic, requests Raw encoding, and
 * assembles the full-screen FramebufferUpdate.
 * @param {{host:string, port:number, connect:(o:{host:string,port:number})=>import('node:net').Socket, timeoutMs?:number}} o
 * @returns {Promise<{rgba:Uint8Array,width:number,height:number}>}
 */
export function grabVncFramebuffer({ host, port, connect, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const sock = connect({ host, port });
    let done = false;
    const finish = (err, val) => {
      if (done) return; done = true;
      try { sock.destroy?.(); } catch { /* ignore */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error(`RFB: timeout after ${timeoutMs}ms`)), timeoutMs);
    if (timer.unref) timer.unref();

    const read = makeReader(sock);
    const write = (b) => sock.write(b);

    (async () => {
      // 1) ProtocolVersion — server sends "RFB 003.00X\n"; reply with min(server, 3.8).
      const pv = await read(12);
      const m = /^RFB (\d{3})\.(\d{3})\n$/.exec(pv.toString('latin1'));
      if (!m) throw new Error(`RFB: bad ProtocolVersion ${JSON.stringify(pv.toString('latin1'))}`);
      const major = Number(m[1]);
      const minor = Math.min(Number(m[2]), 8);
      write(Buffer.from(`RFB ${String(major).padStart(3, '0')}.${String(minor).padStart(3, '0')}\n`, 'latin1'));

      // 2) Security. 3.7+: count + list, pick None(1). 3.3: server dictates a single 4-byte type.
      if (minor >= 7) {
        const count = (await read(1))[0];
        if (count === 0) {
          const rlen = (await read(4)).readUInt32BE(0);
          throw new Error(`RFB: server refused: ${(await read(rlen)).toString('utf8')}`);
        }
        const types = await read(count);
        if (!types.includes(1)) throw new Error(`RFB: server requires auth (types ${[...types]}); configure VNC password-less for the benchmark`);
        write(Buffer.from([1])); // choose None
        if (minor >= 8) {
          const result = (await read(4)).readUInt32BE(0);
          if (result !== 0) throw new Error('RFB: None SecurityResult failed');
        }
      } else {
        const type = (await read(4)).readUInt32BE(0);
        if (type !== 1) throw new Error(`RFB: 3.3 server requires auth type ${type}; use password-less VNC`);
      }

      // 3) ClientInit (shared=1) -> ServerInit (dimensions + pixel format + name).
      write(Buffer.from([1]));
      const si = await read(24);
      const width = si.readUInt16BE(0);
      const height = si.readUInt16BE(2);
      const nameLen = si.readUInt32BE(20);
      if (nameLen) await read(nameLen);
      if (!width || !height) throw new Error(`RFB: degenerate framebuffer ${width}x${height}`);

      // 4) SetPixelFormat -> force 32bpp true-colour, little-endian, bytes [R,G,B,pad].
      const spf = Buffer.alloc(20);
      spf[0] = 0; // message-type SetPixelFormat
      spf[4] = 32; spf[5] = 24; spf[6] = 0; spf[7] = 1; // bpp, depth, big-endian=0, true-colour=1
      spf.writeUInt16BE(255, 8); spf.writeUInt16BE(255, 10); spf.writeUInt16BE(255, 12); // r/g/b max
      spf[14] = 0; spf[15] = 8; spf[16] = 16; // r/g/b shift -> value=R|G<<8|B<<16 -> LE bytes [R,G,B,pad]
      write(spf);

      // 5) SetEncodings -> Raw (0) only.
      const enc = Buffer.alloc(8);
      enc[0] = 2; enc.writeUInt16BE(1, 2); enc.writeUInt32BE(0, 4);
      write(enc);

      // 6) FramebufferUpdateRequest (non-incremental, full screen).
      const fur = Buffer.alloc(10);
      fur[0] = 3; fur[1] = 0; fur.writeUInt16BE(0, 2); fur.writeUInt16BE(0, 4);
      fur.writeUInt16BE(width, 6); fur.writeUInt16BE(height, 8);
      write(fur);

      // 7) Read messages until a FramebufferUpdate (type 0); skip Bell/ServerCutText/ColourMap.
      const out = new Uint8Array(width * height * 4);
      for (;;) {
        const type = (await read(1))[0];
        if (type === 0) break;
        if (type === 2) { /* Bell: no body */ continue; }
        if (type === 3) { await read(3); const n = (await read(4)).readUInt32BE(0); if (n) await read(n); continue; } // ServerCutText
        if (type === 1) { await read(1); const n = (await read(4)).readUInt16BE(2); if (n) await read(n * 6); continue; } // SetColourMapEntries
        throw new Error(`RFB: unexpected server message type ${type}`);
      }
      await read(1); // padding
      const numRects = (await read(2)).readUInt16BE(0);
      for (let r = 0; r < numRects; r++) {
        const hdr = await read(12);
        const rx = hdr.readUInt16BE(0), ry = hdr.readUInt16BE(2), rw = hdr.readUInt16BE(4), rh = hdr.readUInt16BE(6);
        const encoding = hdr.readInt32BE(8);
        if (encoding !== 0) throw new Error(`RFB: unexpected encoding ${encoding} (requested Raw only)`);
        const px = await read(rw * rh * 4);
        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            const s = (y * rw + x) * 4;
            const d = ((ry + y) * width + (rx + x)) * 4;
            out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = 255;
          }
        }
      }
      clearTimeout(timer);
      finish(null, { rgba: out, width, height });
    })().catch((e) => { clearTimeout(timer); finish(e); });
  });
}
