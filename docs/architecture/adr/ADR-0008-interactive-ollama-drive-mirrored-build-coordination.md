# ADR-0008: Interactive host-Ollama drive + mirrored host/VM Copilot build-coordination over the lbabus net bus

- Status: Proposed
- Owner: WIN
- Traces to: LBA-REQ-007 (TCP/UDP coordination bus), LBA-REQ-010 + ADR-0006 (host concentration + ollama); relates to LBA-REQ-006 (multi-VM). Successor to ADR-0006.
- Standards baseline: `repo-standards-review` v0.2.19

## Context

ADR-0006 fixed a **batch** ollama layer on the operator host: completed runs are
concentrated out-of-band and compared by a host-side ollama layer, with the
coordination bus staying **comms-only** (never run data). An operator directive
now adds an **interactive** path on top of that:

- **Ollama runs on the native host** (GPU). A human works in **VS Code + Copilot
  inside a Vagrant clean-room box** and iterates.
- The in-VM Copilot **drives host Ollama over TCP/UDP** and **delegates the builds
  it needs** to a **mirrored Copilot agent on the host** (which owns the toolchain
  / hardware). The host Copilot can drive Ollama too.
- The transport is the **`lbabus net`** bus (LBA-REQ-007, ADR-0003/0004), already
  proven loopback and **guest→host over the private Vagrant network**.

This must preserve the ADR-0006/0007 invariant: **the coordination bus carries
inter-actor comms only — never run data, images, or model corpora**.

## Decision

**Three cleanly separated planes ride the one `lbabus net` transport.**

1. **Coordination plane — comms-only (ADR-0003/0006 invariant).**
   CLAIM/HANDOFF/ACK/DONE/NOTE between the VM agent and the host agent. Build
   delegation lives here: the VM posts a `CLAIM` "need build of target X @ commit
   SHA", the host `ACK`s, builds, and `DONE`s "artifact at &lt;shared path&gt;". No
   artifacts, run data, or model payloads on this plane.
2. **Ollama-drive plane — NEW.** A **thin length-prefixed relay of Ollama's HTTP**
   over `lbabus net` (not a fat `net ollama` verb): each streamed NDJSON
   `done:false` line maps to a `PROGRESS` frame and the terminal `done:true` to a
   `DONE` frame, so token streaming rides the existing envelope types. It is a
   **distinct capability on its own port + session id**, gated by a
   **model allow-list + session token**. It is neither the comms bus nor run data.
3. **Out-of-band artifacts / runs (ADR-0006).** Build artifacts and concentrated
   runs move via a **Vagrant synced folder (+ pull fallback)** — never over the bus.

**Supporting decisions.**
- **Build-request authz.** The host agent honors only an **allow-list of build
  targets** parameterized by a **commit SHA** — no arbitrary shell from the VM.
- **Ollama reachability.** Ollama binds the **private Vagrant network**
  (`OLLAMA_HOST`) so the in-VM agent reaches it; host and VM Copilot both drive it.
- **Ownership.** LINUX owns the **ollama-drive relay PoC** on real GPU hardware
  (proven: ollama 0.32.3 on an RTX PRO Blackwell, drive over HTTP + NDJSON stream)
  and the drive protocol against the `lbabus net` PR. WIN owns the **VMware clean
  room**, `lbabus net`, this ADR, and the **mirrored host-agent build-coordination**.

## Consequences

- **+** A human iterates in the clean room with host-GPU Ollama and host builds,
  without the VM needing the GPU or the full toolchain — the "host builds for the
  VM agent" pattern.
- **+** The ADR-0006/0007 **comms-only** invariant holds: the ollama-drive relay
  and the artifact transfer are **separate planes**, never the coordination bus,
  never run data on the bus.
- **+** One transport, three planes: coordination reuses the proven bus semantics;
  the drive relay reuses the `PROGRESS`/`DONE` envelope types for token streaming.
- **−** The ollama-drive plane is a distinct capability + port to build and secure
  (allow-list, session token); it is not the comms bus and must not be conflated.
- **Open:** the drive relay's exact frame contract (headers, back-pressure) and the
  build-target allow-list schema — folded in as LINUX's relay PoC and WIN's
  build-coordination land; a follow-up may promote this ADR to Accepted.

## Evidence

- `lbabus net` (LBA-REQ-007) proven loopback (TCP CLAIM→ACK, UDP presence,
  ping/pong) **and guest→host over the Vagrant NAT** (an agent inside the VIHS
  clone reached the host listener).
- LINUX proved the Ollama drive over HTTP (non-stream) and NDJSON stream on real
  hardware, and answered the RFC #19 design questions from that evidence.
