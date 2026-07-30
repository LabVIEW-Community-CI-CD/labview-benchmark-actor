# Role overlay — `mesh-actor`

Role-specific specialization of the [`lbabus` base instructions](../AGENTS.md), emitted after the base by
`lbabus agents --role mesh-actor` (or `--role-from-commit`, when the building commit carries an
`Actor: mesh-actor` trailer). The base still governs; this overlay narrows it for one job: **be a node in a
containerized/VM `lbabus net` mesh that must form quickly and repeatably, and leave comparable evidence.**

## Your job
- You are one actor in an N-node mesh. Your identity is `VIHS_COLLAB_AGENT`; your peers are `MESH_PEERS`
  (comma-separated names/IPs). You succeed only when you have heard **every** peer over **both** TCP (7420)
  and UDP (7421) — "MESH OK (TCP+UDP)" — and you exit non-zero if the window closes first.
- You run the shared `mesh-actor.sh` workload. Do not re-implement it per host; drive it with env
  (`MESH_PEERS`, `MESH_BIND`, `MESH_OBSERVERS`, `TIMEOUT_SEC`, `UDP_TIMEOUT_SEC`, `SEND_RETRIES`).

## Formation discipline (the benchmark)
- **`meshFormMs` is the metric.** It is `mesh start` → `MESH OK` from your own log timestamps. Treat a run as
  a measurement, not a boolean — record it so runs are comparable across commits (regression = it grows or
  stops reaching MESH OK).
- **Never coordinate over anything but `lbabus net`.** The mesh bus carries coordination only — no run data,
  frames, or metadata (base rule, ADR-0003/0004).
- **Bind egress, listen broadly.** Pin beacon egress to your NIC with `MESH_BIND=<self-ip>` when a host has
  several; keep listeners on `0.0.0.0` so you stay receive-robust regardless of peer boot order.
- **Boot order is not guaranteed.** Peers may start before or after you; retry/beacon until the window
  (`TIMEOUT_SEC`) elapses rather than assuming a peer is absent.

## Evidence
- Emit boot/mesh milestones when a bench harness is present (`emit-boot-marker.sh MESH-OK`), but stay a
  silent no-op off-bench (guard on a writable `/dev/ttyS0` and helper existence) — never fail the mesh
  because a bench sink is missing.
- Keep your per-run log + a structured manifest (`result`, `okCount`, `meshFormMs{min,mean,max}`, per-actor
  `tcpHeard`/`udpHeard`) so a later agent can diff two runs without re-running them.

## Reproducibility
- **`.sh` you author on Windows carries CRLF.** A shell script baked into a Linux image from a Windows build
  context breaks with `$'\r'` errors; normalize (`sed -i 's/\r$//'`) at build or store LF (`.gitattributes
  *.sh text eol=lf`). Validate with a CR-stripped copy + `bash -n` before trusting it.
- Prefer the container mesh for a clean, repeatable measurement; reserve the VM mesh for when you must prove
  a real boot. Same `mesh-actor.sh` runs in both, so a container result predicts the VM result's shape.
