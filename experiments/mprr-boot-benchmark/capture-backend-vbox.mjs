// capture-backend-vbox.mjs — the LINUX/VirtualBox capture backend for the boot-benchmark recorder.
//
// The recorder CORE is provider-agnostic and talks to a backend through this seam (mirrors how provision-
// guest.sh is shared and only the hypervisor build script differs). WIN implements the same contract over a
// VMware VNC framebuffer grab (vmware-vnc); this is the VBox side.
//
// A capture backend exposes:
//   backend    : string   // capture.backend recorded in the sealed record ('vbox-screenshotpng')
//   transport  : string   // capture.transport (the concrete mechanism)
//   probe()    : { ok, state }                  // is the VM present + running? (VMState)
//   capture(destPngPath) : { ok, path }         // write ONE PNG frame of the VM console to destPngPath
//
// `VBoxManage controlvm <vm> screenshotpng` grabs the framebuffer from POWER-ON, headless, with no guest
// agent/login — so it sees BIOS/GRUB/early-kernel/text-console, exactly the boot window we benchmark (the
// reason WIN uses the VNC console, not Tools-gated `vmrun captureScreen`).
//
// `exec` is injected (default node:child_process) so the argv/contract is unit-testable in CI without a VM.

import { execFileSync } from 'node:child_process';

/** Default exec: run a program, capture stdout; never throw (returns a status object the backend inspects). */
function defaultExec(file, args) {
  try {
    const stdout = execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: typeof err.status === 'number' ? err.status : 1, stdout: err.stdout?.toString?.() ?? '', stderr: err.stderr?.toString?.() ?? String(err) };
  }
}

/**
 * Create a VirtualBox capture backend for one VM.
 * @param {{vm:string, vboxmanage?:string, exec?:(file:string,args:string[])=>{status:number,stdout:string,stderr:string}}} opts
 */
export function createVboxBackend(opts) {
  if (!opts || !opts.vm) throw new Error('createVboxBackend: opts.vm (VM name/uuid) is required');
  const vm = opts.vm;
  const vboxmanage = opts.vboxmanage ?? 'VBoxManage';
  const exec = opts.exec ?? defaultExec;

  return {
    backend: 'vbox-screenshotpng',
    transport: 'VBoxManage controlvm screenshotpng',
    vm,

    /** Is the VM known + what is its VMState (running/paused/poweroff/...)? */
    probe() {
      const r = exec(vboxmanage, ['showvminfo', vm, '--machinereadable']);
      if (r.status !== 0) return { ok: false, state: null, error: r.stderr.trim() || `showvminfo exit ${r.status}` };
      const m = r.stdout.match(/^VMState="?([a-zA-Z]+)"?/m);
      const state = m ? m[1] : null;
      return { ok: state === 'running' || state === 'paused', state };
    },

    /** Capture ONE framebuffer PNG to destPngPath. Returns { ok, path }. */
    capture(destPngPath) {
      if (!destPngPath) throw new Error('vbox backend capture: destPngPath required');
      const r = exec(vboxmanage, ['controlvm', vm, 'screenshotpng', destPngPath]);
      if (r.status !== 0) return { ok: false, path: destPngPath, error: r.stderr.trim() || `screenshotpng exit ${r.status}` };
      return { ok: true, path: destPngPath };
    },

    /** Start the VM headless (used by the live driver at t0; optional for the seal core). */
    start({ headless = true } = {}) {
      const r = exec(vboxmanage, ['startvm', vm, '--type', headless ? 'headless' : 'gui']);
      return { ok: r.status === 0, error: r.status === 0 ? undefined : (r.stderr.trim() || `startvm exit ${r.status}`) };
    },
  };
}

/**
 * The VBox serial-console config the recorder needs so the guest LBABENCH markers land in a HOST file the
 * recorder tails live. Returns the VBoxManage argv (apply while the VM is powered off). Mirror on VMware with
 * serial0.present=TRUE + serial0.fileType=file + serial0.fileName=<hostFile>.
 * @param {{vm:string, hostFile:string, uart?:1|2|3|4}} opts
 */
export function vboxSerialConfigArgs({ vm, hostFile, uart = 1 }) {
  if (!vm || !hostFile) throw new Error('vboxSerialConfigArgs: vm + hostFile required');
  // COM1 base/IRQ 0x3F8/4 -> guest /dev/ttyS0; --uartmodeN file writes the guest's serial output to hostFile.
  return [
    ['modifyvm', vm, `--uart${uart}`, '0x3F8', '4'],
    ['modifyvm', vm, `--uartmode${uart}`, 'file', hostFile],
  ];
}
