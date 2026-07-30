// vbox-vnc-source.mjs — LINUX VirtualBox VNC capture source (task mprr-capture-ring-backbone).
//
// Thin plane-specific wrapper over the SHARED, plane-neutral RFB/VNC streaming core (vnc-source.mjs) — the
// SAME core WIN's vmware-vnc-source.mjs uses — so a LINUX VBox capture and a WIN VMware capture emit
// BYTE-IDENTICAL capture-ring descriptors by construction. The only per-plane difference is how the hypervisor
// exposes the VNC TCP port; VirtualBox serves it via the VRDE VNC module (host-side 127.0.0.1:<port>):
//   VBoxManage setproperty vrdeextpack VNC                          # select the VNC VRDE library (needs the VNC module)
//   VBoxManage modifyvm <vm> --vrde on --vrdeproperty VNCPassword=  # password-less (None auth) so the RFB core connects
//   VBoxManage modifyvm <vm> --vrdeport 5900                        # host-side TCP port -> 127.0.0.1:5900
// then point the source's port at that VRDE port. dhash64 stays 16-hex here (the adapter converts hex -> u64).

import { createVncSource, createStreamingFramebuffer, sampleDescriptor, makeSampler } from './vnc-source.mjs';

/** VirtualBox's VNC VRDE server is conventionally pinned to the standard VNC port; override via opts.port. */
export const VBOX_DEFAULT_VNC_PORT = 5900;

/** LINUX VirtualBox VNC streaming source — the shared RFB core with a VBox VNC default port. */
export function createVboxVncSource(opts = {}) {
  return createVncSource({ port: VBOX_DEFAULT_VNC_PORT, ...opts });
}

// Re-export the shared primitives so a VBox consumer/self-test imports everything from this one plane module
// (symmetry with vmware-vnc-source.mjs).
export { createStreamingFramebuffer, sampleDescriptor, makeSampler };
