# mprr-boot-benchmark — record a mesh-actor BOOT as a deterministic benchmark

The boot-time sibling of [`manual-procedure-record`](../manual-procedure-record/README.md). Instead of a
reviewer stepping through TC-00..TC-10 in the viewer, a **recorder** (a host process) starts a session
**before** the actor boots, captures the boot as an image stream, and correlates the milestone markers the
guest emits — sealing a record that **benchmarks the from-source first boot** (build `lbabus` ~8 s + form
the host-only mesh) and **witnesses it visually**. A cross-iteration diff then catches regressions the gates
and screenshot-hash can't: the build slows, or the boot screen changes.

Co-designed cross-plane (LINUX/VirtualBox ↔ WIN/VMware) on the deterministic-record seam. This directory is
the **LINUX side + the shared core**; WIN owns the VMware VNC capture backend + the cross-iteration diff.

## Why the anchor is dual-clock

A booting console has **no viewer monotonic counter** to read, so there is no single on-screen anchor. The
record uses **two clocks, each authoritative for one thing**:

| Clock | Field | Role |
|---|---|---|
| **Host** `CLOCK_MONOTONIC` | `frame.hostMonotonicMs` | the **visual timeline** — a serial marker pins a milestone to the closest-in-host-time frame, LIVE |
| **Guest** `CLOCK_MONOTONIC` (journald) | `frame.guestMonotonicMs` | the **authoritative timing** — `buildMs`/`meshFormMs` come from here (cross-plane comparable) |

The serial marker's `mono=` is **not** the number of record — it only **cross-checks** the pin (`skewMs`).

## The two milestone channels

```
guest                                                      host recorder
  │  lba-lbabus-build.service / lba-mesh / boot-start oneshot
  │        │ emit-boot-marker.sh <caseId>
  │        ├──────────────► /dev/ttyS0  "LBABENCH <caseId> mono=<uptime>" ──► serial file ──► LIVE frame-pin
  │        └──────────────► journald (logger -t lbabench) ──────────────────► (post-MESH-OK) ─► journalctl
  │                                                                            -o short-monotonic
  ▼                                                                            = AUTHORITATIVE guest ms
```

- **Serial** = live frame-pin. Written only when a serial sink is attached (`[ -w /dev/ttyS0 ]`), so it is a
  silent no-op off-bench.
- **journald short-monotonic** = authoritative guest timing, read once after `MESH-OK`. `BUILD-START`,
  `LBABUS-BUILT`, and `MESH-OK` reuse the unit log lines that **already exist**; `BOOT-START` uses the
  `logger -t lbabench` line the early drop-in writes.

## The benchmark spans (clock decides comparability)

| Span | From → To | Clock | Scope |
|---|---|---|---|
| `buildMs` | `LBABUS-BUILD-START` → `LBABUS-BUILT` | guest | **cross-plane** |
| `meshFormMs` | `LBABUS-BUILT` → `MESH-OK` | guest | **cross-plane** |
| `bootToMeshMs` | `hostT0` → `MESH-OK` | host | **within-plane** only |

Guest-clock spans are comparable VBox ↔ VMware. `bootToMeshMs` includes hypervisor firmware (BIOS/GRUB), so
it is only comparable **same-hypervisor-over-time** — the cross-iteration diff must refuse to cross-plane
compare a `within-plane` span, or it would be diffing firmware, not the build.

## Determinism (fail-closed)

The record **seals only if** every declared milestone is pinned to a frame **and** every pin's
`skewMs = |serialMono − journalMono|` is within tolerance (default 500 ms). A missing pin, a missing
authoritative guest time, an out-of-tolerance skew, or a non-monotonic span **throws — not sealed**. A boot
you cannot deterministically correlate is not a record (same rule as `correlate-seal.mjs`).

On seal, **raw pixels are discarded**; only per-frame `perceptualFingerprint` (dhash-64) + `integrityHash`
(SHA-256) + the dual-clock anchor + the spans remain.

## Visual delta is a WITNESS, not the gate

A booting console has volatile regions (blinking cursor, on-screen clock, DHCP/hostname text) that make raw
dhash-64 deltas spurious run-to-run. So the **guest-clock timing spans are the hard regression gate**; the
visual delta is corroboration with a per-milestone Hamming **tolerance** + optional **ROI mask** over the
volatile region (`visual.gated` defaults to `false` for cut 1). WIN owns tuning the tolerances.

## Files

| File | Role | Owner |
|---|---|---|
| [`boot-benchmark-v1.schema.json`](boot-benchmark-v1.schema.json) | the sealed-record schema (the cross-plane seam) | shared |
| [`seal-boot-benchmark.mjs`](seal-boot-benchmark.mjs) | pure producer: correlate milestones → clock-tagged spans → seal | shared core |
| [`boot-recorder.mjs`](boot-recorder.mjs) | the live driver: capture loop + serial pins + journald read → seal (uniformly `await`s `capture()`, so one driver fits sync + async backends) | shared core |
| [`serial-marker.mjs`](serial-marker.mjs) | the `LBABENCH` wire contract + parser (live frame-pin) | shared |
| [`journal-monotonic.mjs`](journal-monotonic.mjs) | `journalctl -o short-monotonic` → authoritative guest ms | shared |
| [`emit-boot-marker.sh`](emit-boot-marker.sh) | guest emit helper (serial + journald), verbatim both planes | shared |
| [`capture-backend-vbox.mjs`](capture-backend-vbox.mjs) | VBox capture backend (`controlvm screenshotpng`) + serial config | LINUX |
| [`verify-boot-benchmark.mjs`](verify-boot-benchmark.mjs) | 41-check CI proof (seal, spans, gates, parsers, backend, driver await, delta) | LINUX |
| [`record-vbox-boot.mjs`](record-vbox-boot.mjs) | live co-run entry: capture + seal a REAL VBox from-source boot (driver + VBox backend + serial tail + journald over SSH) | LINUX |
| [`capture-backend-vmware.mjs`](capture-backend-vmware.mjs) | VMware capture backend (`RemoteDisplay.vnc` framebuffer grab, minimal RFB) + serial/VNC `.vmx` config | **WIN** |
| [`verify-boot-benchmark-vmware.mjs`](verify-boot-benchmark-vmware.mjs) | 23-check CI proof (contract, `.vmx` config, RFB decode vs a scripted mock — no VM) | **WIN** |
| [`boot-benchmark-diff.mjs`](boot-benchmark-diff.mjs) | cross-iteration diff: timing hard gate (guest cross-plane spans; refuses within-plane across hypervisors) + visual witness | **WIN** |
| [`verify-boot-benchmark-diff.mjs`](verify-boot-benchmark-diff.mjs) | 25-check CI proof (timing gate, cross-plane refusal, visual witness, guards) | **WIN** |
| [`record-vmware-boot.mjs`](record-vmware-boot.mjs) | live co-run entry: capture + seal a REAL VMware from-source boot (driver + VNC backend + serial tail + journald over SSH) | **WIN** |

Fingerprint + PNG decode are reused from `../manual-procedure-record/` (`fingerprint.mjs`,
`capture-adapter.mjs`), so "same `fingerprintAlgo`" is bit-identical cross-plane by construction.

## Capture backend seam

The recorder core is provider-agnostic; a backend implements:

```
backend    : string                      // capture.backend recorded in the sealed record
transport  : string
probe()    : { ok, state }               // is the VM present + running?
capture(destPngPath) : { ok, path }      // write ONE framebuffer PNG (works from power-on, no guest agent)
```

LINUX = `vbox-screenshotpng` (`VBoxManage controlvm <vm> screenshotpng`). WIN = `vmware-vnc` (a framebuffer
grab off the VM's built-in VNC console — **not** `vmrun captureScreen`, which is VMware-Tools+login-gated and
cannot see the BIOS/GRUB/early-kernel boot window we benchmark).

**VMware specifics** ([`capture-backend-vmware.mjs`](capture-backend-vmware.mjs)): VMware has no CLI
framebuffer grab, so the backend enables the VM's built-in VNC server and grabs one frame via a minimal,
dependency-free RFB client (node builtins only, `None` auth, forced 32bpp). Two `.vmx` config helpers set it
up while powered off (apply with `upsertVmxConfig`, or feed the Vagrant provider as `v.vmx[...]`):

- `vmwareSerialConfigVmx({ hostFile })` → `serial0.present` / `serial0.fileType=file` / `serial0.fileName`
  (the VMware analog of VBox `--uartmode1 file`, so the guest `LBABENCH` markers land in a host file the
  recorder tails live).
- `vmwareVncConfigVmx({ port })` → `RemoteDisplay.vnc.enabled` / `RemoteDisplay.vnc.port`.

A VNC grab is async, so `vmware-vnc`'s `capture()` returns a Promise. The shared driver
[`boot-recorder.mjs`](boot-recorder.mjs) does `await backend.capture(path)`, and VBox's sync return is
`await`-compatible (`await <non-promise>` is a no-op) — so **one driver fits both backends** (the verify
proves a sync and an async backend seal a byte-identical record).

## Cross-iteration diff (WIN)

[`boot-benchmark-diff.mjs`](boot-benchmark-diff.mjs) pairs two sealed records and reports two layers:

- **Timing = the hard gate.** Spans are paired by id; a comparable span slower than baseline beyond
  `timingToleranceMs` (default 2000) is a **regression** → the gate fails. Comparability follows `span.scope`:
  guest-clock `cross-plane` spans (`buildMs`, `meshFormMs`) are always compared; the host-clock
  `within-plane` span (`bootToMeshMs`) is **refused across different hypervisors**
  (`incomparable-cross-plane`) — comparing it VBox↔VMware would diff firmware, not the build.
- **Visual = a witness.** Reuses [`frame-diff.mjs`](../manual-procedure-record/frame-diff.mjs) to Hamming the
  milestone `settled` frames, re-scored against each milestone's `visual.perMilestone.hammingTolerance`. It
  does not fail the gate unless the record sets `visual.gated=true`. A declared `roiMask` can't be applied
  post-seal (raw pixels are discarded), so it is surfaced as declared-only and the witness Hamming is
  whole-frame.

## Run

```bash
node experiments/mprr-boot-benchmark/verify-boot-benchmark.mjs         # 41/41, no VM required
node experiments/mprr-boot-benchmark/verify-boot-benchmark-vmware.mjs  # 23/23, no VM required (VMware backend + RFB decode)
node experiments/mprr-boot-benchmark/verify-boot-benchmark-diff.mjs    # 25/25, no VM required (cross-iteration timing gate + visual witness)
node experiments/verify-local-gates.mjs                                # boot-benchmark-{seal-spans-and-fail-closed, vmware-vnc-backend, cross-iteration-diff}
```

## Live capture (co-run)

[`record-vbox-boot.mjs`](record-vbox-boot.mjs) is the LINUX half of the live co-run: it starts a VBox VM,
captures the from-source boot at cadence, tails the serial sink for the `LBABENCH` pins, reads the guest
`journalctl -o short-monotonic` over SSH, and seals a `boot-benchmark-v1`. Prep (powered off):
`VBoxManage modifyvm <vm> --uart1 0x3F8 4 --uartmode1 file <serialFile>`, and the VM must have no baked
`lbabus` so the boot is a real from-source build. Env-configurable (`LBA_VM`, `LBA_SERIAL`, `LBA_MILESTONES`,
`LBA_MATCH`, …). WIN runs the VMware VNC equivalent; the two sealed records are then `bootBenchmarkDiff`ed.

**Proven end-to-end** (2026-07-30, scratch VM, mesh-less BUILD leg): 150 frames, all pins correlated,
`buildMs = 5167 ms`, serial↔journald **skews 6–11 ms** (the dual-channel design holds on real hardware), raw
discarded on seal — and the record passes WIN's `boot-benchmark-diff` (self-diff → `PASS` / `TIMING_OK`).

## Milestone emit wiring (LANDED)

Wire shape confirmed cross-plane; [`emit-boot-marker.sh`](emit-boot-marker.sh) is embedded verbatim in
[`../../cleanroom/ubuntu-labview/provision-lbabus-fromsource.sh`](../../cleanroom/ubuntu-labview/provision-lbabus-fromsource.sh)
and called from these units (all best-effort via systemd's `-` prefix, so a failed/absent emit never
perturbs the proven from-source boot path):

| Milestone | Emitted from |
|---|---|
| `BOOT-START` | `lba-boot-marker.service` oneshot (`Before=lba-lbabus-build.service`) |
| `LBABUS-BUILD-START` | `lba-lbabus-build.service` `ExecStartPre=` |
| `LBABUS-BUILT` | `lba-lbabus-build.service` `ExecStartPost=` |
| `MESH-OK` | WIN's `lba-mesh` drop-in (guarded on `[ -w /dev/ttyS0 ]`) |

## Status

Draft (cut 1): schema + shared seal core + the live driver + serial/journald parsers + both capture backends
(VBox screenshotpng, VMware VNC) + emit helper wired into provisioning + the **cross-iteration diff** (timing
hard gate + visual witness) + the verifies, all gated in `verify-local-gates.mjs`. The **LINUX live capture is
proven** (`record-vbox-boot.mjs`: a real VBox from-source boot sealed, `buildMs=5167ms`, 6–11 ms skews,
passes the diff). **Open:** the cross-plane co-run finale — WIN captures a live VMware boot, LINUX a live VBox
boot (same source pin), and `bootBenchmarkDiff` compares the guest spans (`bootToMeshMs` auto-refused across
hypervisors).
