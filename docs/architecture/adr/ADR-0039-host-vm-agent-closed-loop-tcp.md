# ADR-0039: Host↔VM-agent closed loop over the lbabus net TCP bus (off GitHub Discussions)

- Status: Accepted
- Date: 2026-08-03
- Deciders: operator directive (2026-08-03, "I will act as the human in the loop on the VM … you type into the visual studio code window to trigger the agent on the VM"; "TCP, deprecate the use of github discussions"; the verdict-type fork resolved to option A — extend the net type set) + agent
- Relates to: LBA-REQ-059, LBA-REQ-007 (TCP/UDP coordination bus), ADR-0003/0004 (bus wire format + time sync), ADR-0008 (mirrored host/VM Copilot coordination over lbabus net), ADR-0032 (human-assisted VM bridge), ADR-0035/0037/0038 (Handoff Beacon Protocol — capture-status / reviewer visual verdict / verdict bus announcement), reviewer-workstation/drive-agent-chat.sh, tools/collab-cli (lbabus net)

## Context

The Handoff Beacon Protocol (ADR-0035..0038) made the human-in-the-loop machine-observable, and
`reviewer-workstation/drive-agent-chat.sh` let the host keyboard-drive the reviewer VM's Copilot agent —
but the drive was **fire-and-screenshot**: the host injected a prompt and a human read PNGs to judge the
result. There was no programmatic **read-back**, so the host agent could not close the loop with the VM
agent. Separately, the reviewer-verdict announcement (ADR-0038) rode a **GitHub Discussion** (the `lbabus
post` transport); an operator directive now moves coordination onto **TCP** and deprecates the Discussion
transport as the direction ("TCP, deprecate the use of github discussions"). The TCP bus already exists
(`lbabus net`, LBA-REQ-007, ADR-0003/0004) and guest→host is proven
(`experiments/provider-delegation/vm-run-evidence.json` — a host listener at `10.0.2.2:7420` received a
`DONE` from inside the VM).

## Decision

Close the host↔VM-agent loop over `lbabus net` TCP, and give the reviewer verdict a first-class semantic
type on that bus.

- **Host-side structured read-back (`await-agent-reply.mjs`).** After the host drives the VM's chat, it runs
  `lbabus net listen` and **awaits the VM agent's reply frame correlated by task id**, parsing the rendered
  frame into a structured reply + receipt. It **fails closed** on a task mismatch or a timeout — the host
  never accepts an uncorrelated frame as the answer. This is the structured consumer that `net listen` alone
  did not provide (it only prints lines).
- **The closed-loop driver (`drive-agent-closed-loop.sh`)** composes the two halves: it starts the awaiter,
  then keyboard-injects the prompt **plus a deterministic report-back line** (`lbabus net send … --type <T>
  --task <id> --message "<one line>"`) so the VM agent reports back over TCP. The injected prompt **must be
  single-line** (`keyboardputstring` treats a newline as Enter/submit).
- **Semantic verdict types on the net envelope (option A).** The `net` type set gains
  **`RESOLVED`/`REFINE`/`BLOCKED`** (mirroring the Discussion-layer `CollabMessage` types), so a signed
  reviewer verdict announces over `net` as a first-class semantic event (pass→RESOLVED / changes→REFINE /
  fail→BLOCKED) — not merely a `NOTE` payload — preserving ADR-0038's semantics on TCP. This is the concrete
  first step of moving verdict coordination **off** the GitHub Discussion bus.
- **Comms-only holds (ADR-0003).** The reply / announcement carries a **one-line status only** — never run
  data, images, or artifacts (those move out-of-band). Private-network bind only; never exposed publicly.
- **Gate it fail-closed (`closed-loop-readback`).** A pure parser self-test (7/7), the committed live+loopback
  receipt (a matching task closes the loop; a wrong task fails closed; the `RESOLVED` type rides `net`), and a
  source assertion that the `net` type set carries the verdict statuses.

This is requirement **LBA-REQ-059**.

## Consequences

- **The host agent can act on the VM agent's result.** The loop is programmatic + correlated, so the host can
  drive the reviewer VM's agent and consume its structured answer — the basis for ADR-0008's mirrored
  coordination and an agentic release-with-review. Proven **live**: three drives from the real VM
  (`senderId=WIN`) — the loop, a real benchmark review (2604 ms / 5 samples → PASS via the extension's
  `lba-benchmark-summary` tool), and the signed verdict announced as `RESOLVED` — all over TCP, no GitHub
  Discussion.
- **Verdict coordination is moving off GitHub Discussions.** The verdict now has a first-class semantic type
  on `net`. The **full** migration (the extension/MCP poll/post, `post-verdict.mjs`, the CI mock GraphQL
  harness, ADR-0038's Discussion path) remains a separate, larger governed change; this ADR sets the direction
  + the transport.
- **Deferred:** retiring the GitHub-Discussion transport (`lbabus post`/`poll`) and porting the extension's
  poll/post coordination commands + the release-CI announcement onto `net`; a follow-up may deprecate
  ADR-0038's Discussion path once the net announcement is wired end-to-end into the release flow.
