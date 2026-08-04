# Join the Mesh

> A task-first quickstart: take your activated golden VM from a **local benchmark actor**
> to a **participant in the cross-plane benchmark mesh** — answering a dispatched run and
> returning your first plane-tagged receipt. Aligns to **ISO/IEC/IEEE 26514:2022 §5**
> (task-oriented information for users). For the first-benchmark path see
> [Getting Started](./getting-started.md); for the full workflow see the
> [User Guide](./user-guide.md); for every command see the
> [Command Reference](./command-reference.md).

## Who this is for

The **LabVIEW community member** who already has a working, activated golden VM (see
[Getting Started](./getting-started.md)) and wants to contribute cross-plane benchmark
results to the mesh. If you are an **agent**, drive these same steps through the MCP
server and the coordination-bus tools.

## What the mesh is (in one paragraph)

The mesh coordinates **runs, not a central database**. A requester dispatches a cross-plane
benchmark; volunteer actors each run it **inside their own sandbox-isolated golden VM** and
return a **plane-tagged receipt**. A run is *fulfilled* only when enough independent actors
from the requested planes returned a valid receipt for the **same benchmark identity**.
Nobody uploads run data to a server — the receipts *are* the result, owned by whoever
produced them.

## 1. Register your golden VM as an actor

Your activated golden VM is registered in your **local** actor registry (it stays on your
machine — no boxes are published to a shared registry). Registration binds the actor to its
activation receipt, so an unactivated box can never join as a benchmark actor.

## 2. Watch for a dispatched run

On-demand runs are dispatched **GitHub-natively** — a `repository_dispatch` event (type
`mesh-run`) carries a validated request naming the benchmark, how many independent actors are
required, and which planes must be covered. The repository is the queue; there is no server
to run and the whole exchange is auditable.

## 3. Run it and return a plane-tagged receipt

Your actor runs the requested benchmark headlessly in its VM (frame-locked at exactly
12 FPS, the shared clock) and returns a `workload-trend@1` receipt **tagged with your plane**
(`LINUX` or `WIN`). The fulfillment gate accepts the run only when enough distinct
cross-plane actors returned a valid receipt for the same benchmark identity.

## 4. (Opt-in) join the verified tier

For higher-assurance runs, sign your returned receipt with your **enrolled** key. A verified
run additionally records each attestation in an append-only, RFC-6962 transparency log, so a
consumer can *verify before consuming*: identity + signature + transparency inclusion +
append-only, folded into a single **fully-attested** verdict. Participation never requires
this — sandbox isolation is the floor; attestation is the ceiling.

## 5. Confirm your contribution

The mesh coverage view shows which benchmarks have been fulfilled, across which planes, by
how many actors — and the benchmark-suite parity view shows which benchmarks are proven
comparable across Linux and Windows. Your returned receipt appears as one of the independent
cross-plane witnesses.

## Trust & privacy

- **Your VM, your data.** Runs execute in *your* isolated golden VM; run data never crosses
  the coordination bus.
- **No central hoarding.** The mesh moves coordination messages, not results.
- **Attestation is opt-in.** The verified tier is a stronger trust ceiling, not a gate on
  joining.

## Where to next

- [Getting Started](./getting-started.md) — provision + activate a golden VM.
- [User Guide](./user-guide.md) — the full review + coordination workflow.
- [Command Reference](./command-reference.md) — every contributed command.
- [FAQ](./faq.md) — common questions.
