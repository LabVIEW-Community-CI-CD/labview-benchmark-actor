# Ollama-governed container coordinator over `lbabus net` (WAN-free)

Operator directive (`cross-plane-ollama-bus`, proven first on the WIN plane): a **collab-cli in a container is
the COORDINATOR** (`lbabus net listen`); the **host `lbabus`, GOVERNED BY OLLAMA**, coordinates it
(`lbabus net send`); ollama gets an **entrypoint to iterate on printing diagnostics**. No WAN needed — the
container talks to the host + host-exposed ollama over the **local docker network**.

This is the **LINUX** implementation, proven end-to-end and parity-checked against WIN. Maintainer harness
(needs docker + ollama) — **not** a CI gate.

## Design (WAN-free)

```
 host (ollama-governed)                         bare container (no .NET, no WAN)
 ┌─────────────────────────────┐                ┌────────────────────────────────┐
 │ ollama (GPU) --generates-->  │  lbabus net    │  lbabus net listen --echo       │
 │ lbabus net send  ───────────────────────────▶ │  (VIHS_COLLAB_AGENT=CONTAINER)  │
 │ (VIHS_COLLAB_AGENT=LINUX-HOST)│  bus-msg@1     │  prints + ACKs each frame       │
 └─────────────────────────────┘   ◀─── ACK ─────┴────────────────────────────────┘
```

The self-contained `lbabus` (single file, ~64 MB) is **built on the host** (`dotnet publish -r linux-x64
--self-contained`) and **mounted read-only** into a bare image, so the container downloads/builds **nothing**
— which also sidesteps any container-NAT / SDK-over-WAN problem.

## Reproduce

```bash
cd experiments/ollama-bus
./publish-lbabus.sh                       # host-build the self-contained lbabus -> $HOME/lba-net/publish
LBABUS_DIR=$HOME/lba-net/publish ./run-coordinator.sh 7420 4 &   # coordinator: bare container, 4 messages
LBABUS=$HOME/lba-net/publish/lbabus LOOP=3 INTERVAL=1 ./gov-send.sh 7420   # governor: HELLO + 3 ollama NOTEs
```

- `publish-lbabus.sh [rid]` — self-contained single-file publish (default `linux-x64`).
- `run-coordinator.sh [port] [count]` — bare-container `lbabus net listen --echo` (count `0` = forever).
- `gov-send.sh [port]` — the ollama-governed governor. `LOOP` iterations, `INTERVAL` seconds between; each
  iteration has **ollama generate** the diagnostic line (`OLLAMA_MODEL`, default `llama3.1:8b`) and sends it.

## Proven (see `receipt.json`)

- Self-contained `lbabus` runs on **bare `ubuntu:22.04`** (no .NET) — mounted, downloads nothing.
- Container coordinator received **4/4** frames and echoed `CONTAINER #1..#4 ACK ackOf:<seq>`; the governor saw
  each reply. The 3 `NOTE` payloads were **generated live by ollama** on the RTX GPU (distinct each iteration).
- **Envelope cross-check vs WIN: identical** — `labview-benchmark-actor/bus-msg@1`, a 4-byte big-endian
  length-prefixed UTF-8 JSON frame (`senderId`/`seq`/`ts.wall`/`type`/`task`/`payload`/`ackOf`), types
  `CLAIM|ACK|HANDOFF|DONE|PROGRESS|NOTE|HELLO`. Only infra addressing differs (Linux `docker0` bridge
  `172.17.0.1` vs WIN nat gateway `172.21.96.1`); Linux port-publish works cleanly (no Windows `hnsCall` glitch).

## The `lbabus net` surface (`tools/collab-cli/Net.cs`)

- `listen|serve` — `--tcp <port>` `--udp <port>` `--bind <0.0.0.0>` `--echo` `--count <n>` (`0`=∞) `--session`
- `send` — `--host` `--tcp|--port` `--type` `--message|--message-file` `--task` `--session` `--seq` `--ackof` `--await <s>`
- `ping` — `--host` `--tcp|--port` `--timeout` (connect + NOTE + await echo; reports RTT)
- `beacon` — `--host <bcast>` `--udp|--port` `--interval` `--count` `--session` `--task` `--message`
