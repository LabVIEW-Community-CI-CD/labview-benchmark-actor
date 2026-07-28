# ollama-drive relay (RFC #19, LINUX slice)

A **thin relay** that drives the host's **ollama** over the same **ADR-0003 framing** `lbabus net`
uses, so a Copilot agent inside a clean-room VM (or the host agent) can send a prompt over the private
net and stream the completion back. This is **plane 2** of RFC #19 (the *ollama-drive* plane); it is
distinct from the comms bus (plane 1) and never carries run-data/artifacts (plane 3, out-of-band).

## Design (answers my own RFC #19 Q1/Q4/Q5)
- **Thin, not a fat verb.** The relay carries a drive request in over a `labview-benchmark-actor/bus-msg@1`
  envelope (4-byte big-endian length prefix + UTF-8 JSON, 1 MiB fail-closed cap — identical to
  `lbabus net`), forwards it to ollama's HTTP `/api/generate`, and streams the reply back as
  **PROGRESS** frames (one per NDJSON token, `done:false`) + a terminal **DONE** frame (`done:true`,
  metrics). Maps 1:1 onto `lbabus net`'s PROGRESS/DONE types — no ollama-API modelling in the transport.
- **Own port/session** (Q4): the drive plane binds a distinct port (default `11511`) from the comms bus.
- **Reach from the VM** (Q5): run the relay with `--host 0.0.0.0` on the private Vagrant net so the VM
  reaches it, while **ollama itself stays localhost-bound** (the relay is the only thing exposed — a
  tighter posture than rebinding `OLLAMA_HOST` directly).

## Usage
```sh
# host: start the relay (loopback; use --host 0.0.0.0 to expose on the private net)
node ollamaDrive.mjs relay --port 11511 --ollama 127.0.0.1:11434

# agent: send a prompt, stream the completion
node ollamaDrive.mjs drive --host 127.0.0.1 --port 11511 --model llama3.1:8b --prompt "..."
```

## Proven (2026-07-28, real hardware)
Host: ollama 0.32.3 on an NVIDIA RTX PRO 1000 Blackwell (8 GB); models `llama3.1:8b`, `qwen2.5:14b`,
`vichange8b-2shot|fewshot`.
- deterministic: `drive … --prompt "Reply with exactly OLLAMA_DRIVE_OK"` → `OLLAMA_DRIVE_OK` (5 token-frames, exit 0)
- streaming: `--prompt "Count from one to five"` → `One. Two. Three. Four. Five.` (10 token-frames, 415 ms, exit 0)

## Next
- **Authz** (Q2): model allow-list + per-session token before the relay forwards.
- **Interop**: fold the framing onto `lbabus net`'s `Net.cs` `BusWire` (this PoC re-implements it in Node,
  wire-compatible) — a `net`-adjacent relay once PR #20 lands.
- **VM leg**: run `--host 0.0.0.0` + drive from inside the VMware/VirtualBox clean-room guest over the
  private net (the guest→host reachability is already proven by `lbabus net`).
