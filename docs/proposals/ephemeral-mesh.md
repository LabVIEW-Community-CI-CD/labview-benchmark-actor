# Proposal: Canonical Ephemeral Mesh — reproducible, disposable actor VMs (cattle, not pets)

Status: DRAFT (for WIN review — cross-plane parity) · Author: LINUX plane · Date: 2026-07-31 · Task: ephemeral-mesh

> **P1 (Linux/VirtualBox) is PROVEN LIVE.** The full cattle cycle — golden snapshot → linked clone → boot →
> lbabus loopback `MESH OK (TCP+UDP)` → **destroy** — runs end to end and seals an `ephemeral-mesh@1` receipt,
> re-validated offline and gated on every PR. See [experiments/ephemeral-mesh/](../../experiments/ephemeral-mesh/)
> and its sealed [receipt.json](../../experiments/ephemeral-mesh/receipt.json).

## 1. Summary

Replace hand-maintained, long-lived actor VMs with a **canonical ephemeral mesh**: actor VMs are **built
reproducibly from a golden image, cloned into a mesh, used, and destroyed** — they explicitly do **not** need to
survive a reboot. If a node drifts or breaks, you **rebuild** (fast) instead of repair. Every node uses a
**known local `actor` account** (a non-secret dev default), so the agent's VM bridge connects reliably with zero
credential friction. The same topology spec, lifecycle, and receipt run on **both planes** (Ubuntu/VirtualBox and
Windows), giving cross-plane parity for the benchmark and authoring self-tests.

This is a **cattle, not pets** reframe. It is a plan; P1 (a Linux proof on the already-working box) is scoped to
infrastructure only (bridge + lbabus `MESH OK` + the ephemeral cycle), not the authoring self-test.

## 2. Motivation (why now)

Standing up the persistent `actor-win11-decouple` VM by hand cost hours of avoidable friction, every bit of it a
symptom of treating a VM as a **pet**:

- VBox `guestcontrol` cannot authenticate a **Microsoft account** (the operator's interactive login) — only a
  local account with a real password.
- A boot-time step **re-stamps the local `vagrant` password** to a provisioned value, so `net user vagrant
  vagrant` only held until the next reboot; autologin then failed at the login screen.
- Elevation for installs (VIPM into Program Files, HKLM) needs a full admin token, but `guestcontrol` hands the
  account a **UAC-filtered token**, and a non-elevated process cannot self-elevate.

None of these are bugs to fix on that VM — they are the cost of **persistence + hand-configuration**. The fix is
to stop persisting: build a known-good image once, clone disposable nodes with **known local credentials**, run,
and destroy. The credential model already exists in the repo (`cleanroom/ubuntu-labview/vm-credentials.csv`,
`actor/actor` as the documented non-secret dev default from `build-virtualbox.sh`).

## 3. Design principles

1. **Known local identity everywhere.** Every node has a **local `actor` account** with a known dev password
   (non-secret on a public repo; real per-VM credentials stay in the operator-held, gitignored
   `vm-credentials.csv`). No Microsoft/PIN accounts. The bridge's `<vm>.user`/`<vm>.pass` are the same `actor`
   pair for every node → reboot-immune because we never reboot-and-repair.
2. **Golden → clone N → run → destroy.** One golden image per plane, built once from a **stock ISO** (Ubuntu
   already has `build-virtualbox.sh`; Windows needs the analog). A topology spec (the existing
   `mesh-actors.csv` schema) clones N ephemeral nodes with unique identities (`actor1/actor2/…`, host-only
   `192.168.56.x`).
3. **One driver.** `tools/vm-bridge/lba-guest.sh` (host-side, secret-safe `--passwordfile`) drives every node
   headlessly. Backend-agnostic by design: VBox `guestcontrol` today; SSH / WinRM / VMware `vmrun` slot in
   behind the same `check|cmd|ps|run|cp` surface. Same driver, both planes.
4. **Comms-only mesh + host concentration** (already the repo's law): nodes coordinate over lbabus net
   (TCP 7420 reliable + UDP 7421 presence) to `MESH OK (TCP+UDP)`; **run data never crosses the bus** (VM-local
   mprr ring, LBA-REQ-009); cross-plane comparison happens by **host concentration** (LBA-REQ-010/014).
5. **Everything is a receipt.** Each lifecycle run seals an `ephemeral-mesh@1` receipt (nodes, identities,
   mesh outcome, timings, teardown proof) — re-runnable, gate-able, no-rot, consistent with the repo's other
   receipts.

## 4. What already exists (I build on this)

| Asset | Path | Role |
| --- | --- | --- |
| Ubuntu golden builder | `cleanroom/ubuntu-labview/build-virtualbox.sh` | stock-ISO → unattended VBox VM, `actor/actor` default |
| Shared provisioning | `cleanroom/ubuntu-labview/provision-guest.sh` + `provision-lbabus-fromsource.sh` | LabVIEW 2026 + **first-boot self-build lbabus** (no baked binary) |
| Ubuntu mesh | `cleanroom/ubuntu-labview/mesh/` (`Vagrantfile`, `virtualbox/`) | clones N from `mesh-actors.csv`, per-node identity, `lba-mesh.service` |
| Mesh runtime | `tools/collab-cli/ci/mesh-actor.{sh,ps1}` | TCP+UDP listen/fan-out → `MESH OK (TCP+UDP)` |
| Proven Windows mesh | `experiments/multi-vm-topology/` | 2-node VMware, receipt `pass:true`, TCP/UDP coordination |
| The bridge | `tools/vm-bridge/lba-guest.sh` | secret-safe guestcontrol driver |
| Credential model | `cleanroom/ubuntu-labview/vm-credentials.csv` (gitignored) | `vm_name,hypervisor,guest_user,guest_password,…`; `actor/actor` dev default |

Requirement + ADR boundaries already in force: **LBA-REQ-006** (declarative multi-VM topology, unique
identities, clean teardown, no cross-VM run-data), **LBA-REQ-007** (TCP/UDP comms-only bus), **LBA-REQ-009**
(VM-local run storage), **LBA-REQ-010/014** (host concentration + deterministic cross-plane compare); ADR-0003
(bus wire), ADR-0004 (UDP presence, not run-clock), ADR-0005 (bus is not a run-data channel).

## 5. Gaps this proposal closes

1. **No Windows-from-stock-ISO golden builder** with a baked **local `actor` account** — `reviewer-workstation/`
   only *consumes* a maintainer box. This gap is exactly the friction we hit. → build the analog of
   `build-virtualbox.sh` for Windows.
2. **No single ephemeral lifecycle** (`build → seal → clone → identity-inject → mesh-prove → destroy → attest`)
   spanning both hypervisors/planes with one spec and one receipt. → one `experiments/ephemeral-mesh/`
   orchestrator wrapping the existing assets. **(P1 delivers the first slice:
   [run-ephemeral-mesh.mjs](../../experiments/ephemeral-mesh/run-ephemeral-mesh.mjs) does
   golden→clone→run→destroy on the Linux/VBox plane; P2 generalizes it to N nodes + both planes.)**
3. **Credential defaults differ** (`build-virtualbox.sh` = `actor`, `build-vmware.ps1` = `labview`). →
   standardize on `actor` across creation scripts.

## 6. Architecture — the lifecycle

```
  [stock ISO] --build--> [GOLDEN image]  (local actor acct + GA + LabVIEW + first-boot lbabus)   <-- once per plane
                              | seal (snapshot 'golden-ready')
                              v
        topology spec  --clone N-->  actor1 .. actorN   (unique hostname + host-only IP + identity record)
        (mesh-actors.csv)               |  identity-inject (per-node /etc/lba-mesh-actor or Windows equiv)
                                        v
                              lbabus net  TCP 7420 + UDP 7421  -->  MESH OK (TCP+UDP)     (comms-only)
                                        |  (run data stays VM-local; host concentration for compare)
                                        v
                              seal ephemeral-mesh@1 RECEIPT  -->  destroy -f all nodes  (attest teardown)
```

- **Driver:** the host runs `lba-guest` against each node using the one `actor` credential; nodes never expose a
  reused secret. Ephemeral because a broken node is destroyed + re-cloned, never repaired.
- **Receipt (`ephemeral-mesh@1`):** `{ plane, hypervisor, golden, nodes:[{id,hostname,ip,heardTcp,heardUdp}],
  meshOk, durations, teardown:'destroyed', createdAt }` — the re-runnable proof + a local-gate anchor.

## 7. Phased plan

- **P1 — Linux proof (✅ DONE, golden `lba-ubuntu2404-labview2026-scratch@mesh-node-ready`):** the full cattle
  cycle proven **live** — golden snapshot → **linked clone** → boot → lbabus **loopback `MESH OK (TCP+UDP)`** →
  **destroy** — driven by the *known* `actor` identity over an **SSH key** (no password ever). Sealed to an
  `ephemeral-mesh@1` receipt and gated offline (`ephemeral-mesh-receipt-green`). Boot→SSH-ready ≈13 s; clean
  teardown confirmed (no leftover VM/disk). **Infra only** — no authoring self-test. *Chosen variant: loopback
  `MESH OK` inside a throwaway clone that is then **destroyed** (true cattle), rather than snapshot-rollback.*
- **P2 — canonical orchestrator:** `experiments/ephemeral-mesh/` = one lifecycle CLI (`build|clone|run|destroy`)
  + a `verify-ephemeral-mesh.mjs` self-test + an authoring-namespaced gate in the shared `verify-local-gates`.
- **P3 — Windows golden builder:** from-stock-ISO Windows image with a **local `actor` account** + Guest
  Additions + first-boot lbabus, mirroring `build-virtualbox.sh`. Kills the `actor-win11-decouple` friction class.
- **P4 — cross-plane mesh proof:** N Ubuntu + N Windows nodes, `MESH OK` on both planes, one receipt; then the
  authoring self-test (author→analyze→agree) runs on the mesh instead of a pet.

## 8. Requirements traceability (proposed)

New requirement IDs to register once approved (illustrative): an **ephemeral-VM-lifecycle** requirement
(reproducible build→clone→run→destroy with a known local identity, no reboot-survival), and a
**cross-plane-mesh-parity** requirement (same topology spec + receipt on both planes) — each with a Proven
receipt + a shared-runner gate, extending LBA-REQ-006/007.

## 9. Security posture

- The `actor/actor` dev credential is **non-secret by design** on a public repo (documented in
  `vm-credentials.csv` header); **real** per-VM passwords live only in the operator-held, gitignored copy and
  never transit the model (the bridge reads them via `--passwordfile`).
- Nodes are **VM-sandboxed** and **disposable**; a compromised or drifted node is destroyed, not trusted.
- Comms-only bus (no run-data on the wire); private/host-only network binding by default (ADR-0004/0005).

## 10. WIN ⇄ LINUX split (proposed — WIN to confirm)

- **LINUX:** the ephemeral lifecycle orchestrator + receipt + gate; P1 Linux proof (done); the Ubuntu golden
  parity fixes; drives its own VirtualBox nodes.
- **WIN:** cross-plane parity review; the Windows golden builder can be co-owned (LINUX drafts the from-ISO
  flow, WIN validates on the VMware plane); the P4 cross-plane receipt (mirrors the #191/#199 witness pattern).
- Boundaries are a proposal — WIN weighs in for parity.
