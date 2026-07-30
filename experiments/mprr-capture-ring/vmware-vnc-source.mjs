// vmware-vnc-source.mjs — WIN VMware RemoteDisplay.vnc capture source (task mprr-capture-ring-backbone).
//
// Thin plane-specific wrapper over the SHARED, plane-neutral RFB/VNC streaming core (vnc-source.mjs). The RFB
// implementation here originally lived in this file (PR #180); it was every-line generic RFB, so it was
// extracted to vnc-source.mjs so the LINUX VirtualBox source (vbox-vnc-source.mjs) reuses the EXACT same code
// path — byte-identical capture-ring descriptors cross-plane by construction. This file preserves the WIN API
// (createVmwareVncSource + the re-exported streaming primitives) so existing wiring/self-tests are unchanged.
//
// VMware exposes RemoteDisplay.vnc as a host-side TCP port (127.0.0.1:590x) when the .vmx enables
// RemoteDisplay.vnc.enabled = "TRUE" (see mprr-boot-benchmark/capture-backend-vmware.mjs vmwareVncConfigVmx).

export { createStreamingFramebuffer, sampleDescriptor, makeSampler } from './vnc-source.mjs';
import { createVncSource } from './vnc-source.mjs';

/** WIN VMware VNC streaming source — the shared RFB core with VMware framing. See createVncSource for options. */
export function createVmwareVncSource(opts = {}) {
  return createVncSource(opts);
}
