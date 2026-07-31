# experiments/ephemeral-mesh — canonical ephemeral mesh (P1: Linux proof)

**Cattle, not pets.** A mesh node is a *disposable* artifact: cloned from an immutable golden snapshot,
driven with a **known local identity** (`actor` + an SSH key — never a password), made to prove the lbabus
bus, then **destroyed** so nothing survives. No reboot-survival, no hand-repair, no drift. This directory is
the first live proof of that lifecycle on the LINUX / VirtualBox plane.

Design proposal: [docs/proposals/ephemeral-mesh.md](../../docs/proposals/ephemeral-mesh.md).

## What P1 proves

```
golden snapshot  ─clone(linked)→  ephemeral node  ─boot→  loopback lbabus MESH OK  ─→  DESTROY
lba-ubuntu2404-…    (actor+key)     lba-ephemeral-*         TCP+UDP over 127.0.0.1        (clean teardown)
   @mesh-node-ready
```

1. **golden → linked clone** — `VBoxManage clonevm … --snapshot mesh-node-ready --options link`. Fast,
   space-efficient, and the golden is never mutated.
2. **known-identity drive** — the clone is reached only over SSH **key auth** as `actor` (the dev-default,
   non-secret identity baked into the golden). No password is ever handled.
3. **lbabus MESH OK (loopback)** — inside the clone, [loopback-mesh-proof.sh](loopback-mesh-proof.sh) makes
   the node send to **itself** over `127.0.0.1` and hear itself back over **both** transports (reliable TCP
   frame + UDP presence beacons) → `MESH OK (loopback TCP+UDP)`. Comms-only, no shared storage
   (LBA-REQ-007, ADR-0003/0004). Non-standard ports `47420/47421` so it never collides with a running
   `lba-mesh.service`.
4. **destroy** — `VBoxManage unregistervm --delete`; the receipt records the removal was confirmed
   (LBA-REQ-006 clean teardown, no cross-VM run-data).

## Files

| File | Role |
| --- | --- |
| [run-ephemeral-mesh.mjs](run-ephemeral-mesh.mjs) | **Live** host-side orchestrator: clone → boot → prove → seal receipt → destroy. Needs `VBoxManage` + `ssh`/`scp` + the trusted `actor` key. |
| [loopback-mesh-proof.sh](loopback-mesh-proof.sh) | In-guest single-node lbabus TCP+UDP loopback proof. |
| [ephemeralMesh.mjs](ephemeralMesh.mjs) | Schema + **offline** validator (`validateEphemeralMeshReceipt`, `ephemeral-mesh@1`). |
| [verify-ephemeral-mesh.mjs](verify-ephemeral-mesh.mjs) | **Offline** self-test: re-validates the committed receipt + fails-closed teeth. Runs in CI (no VM). |
| [receipt.json](receipt.json) | Sealed evidence of one full cattle cycle. |

## Run it

```bash
# Live (on a VirtualBox host with the actor key trusted by the golden):
node experiments/ephemeral-mesh/run-ephemeral-mesh.mjs        # clone → prove → destroy, seals receipt.json
node experiments/ephemeral-mesh/run-ephemeral-mesh.mjs --keep # leave the clone up to debug (receipt won't validate)

# Offline (any runner, no VM — this is the gate):
node experiments/ephemeral-mesh/verify-ephemeral-mesh.mjs
```

Overridable via env: `LBA_GOLDEN_VM`, `LBA_GOLDEN_SNAP`, `LBA_SSH_USER`, `LBA_CLONE_SSH_PORT`,
`LBA_CLONE_MEM`, `LBA_CLONE_CPUS`, `LBA_BOOT_TIMEOUT_SEC`.

## Security

The identity is `actor` — the **non-secret dev-default** baked into public-repo golden boxes — reached over
an **already-trusted SSH key**. No password is ever read, sourced, or emitted. Per-deployment secret
credentials (the `mesh-actors.csv` model) stay operator-held and are never committed or logged.

## Next (see the proposal)

- **P2** — promote the orchestrator to a canonical `ephemeral-mesh` lifecycle + wire the receipt into the
  shared gate.
- **P3** — a Windows-from-stock-ISO golden builder with a baked local `actor` account (the missing piece
  that ends the hand-repaired-pet friction on Windows), mirroring `cleanroom/ubuntu-labview/build-virtualbox.sh`.
- **P4** — real 2-node + cross-plane (LINUX↔WINDOWS) mesh, and the authoring self-test running on ephemeral nodes.
