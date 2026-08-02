# Information for Users — Audience and Task Model

> Aligns to **ISO/IEC/IEEE 26514:2022 §5** (identify audiences, tasks, and the
> information they need). Drives which information items exist and what each one
> contains. Governed under `LBA-REQ-034`.

## Related surfaces

- [Getting Started](./getting-started.md)
- [Command Reference](./command-reference.md)
- [Navigation and Search](./navigation-and-search.md)
- [FAQ](./faq.md)
- [Glossary](./glossary.md)
- [Delivery Profile](./delivery-profile.md)
- [Conformance Boundary](./conformance-boundary.md)

## Audiences

| Audience | Role family | Background | Learning stage | Frequency | Operational context | Preferred surfaces |
| --- | --- | --- | --- | --- | --- | --- |
| **LabVIEW community member** | direct product user | knows LabVIEW; new to this extension + its VM/mesh model | first-time → regular | occasional → regular | VS Code on their own Windows/Linux desktop, driving a benchmark on a local VM | Getting Started, User Guide, Command Reference, FAQ |
| **Autonomous AI agent** | automation operator | operates the extension through the MCP server + language-model tools | machine consumer | high | headless, orchestrating captures / panels / corroboration on the operator's behalf | `AGENTS.md`, MCP tool docs, Command Reference |
| **Maintainer** | core operator | knows repo doctrine, the gate suite, and GitFlow | advanced | high | terminal + PR review under the fail-closed gates | `README.md`, `docs/`, Command Reference |
| **Reviewer** | evidence reviewer | performs the human sign-off on a corroborated release | occasional | medium | reviewer workstation / codespace, verify-before-install | Reviewer manual test plan, Command Reference, Glossary |

## Tasks

| Task | Why | Frequency | Preconditions | Fault tolerance | Consequence if missed | Priority surfaces |
| --- | --- | --- | --- | --- | --- | --- |
| Install + activate the extension | get a working benchmark actor | once | VS Code; a benchmark VM or codespace | low | cannot benchmark at all | Getting Started, User Guide |
| Capture a LabVIEW launch benchmark | measure real IDE-launch performance at exactly 12 FPS | regular | LabVIEW present on the actor; capture prerequisites | medium (repeatable) | no evidence to review or compare | Command Reference (`Capture LabVIEW Launch`), User Guide |
| Review a run with the time cursor | read machine cost against the captured frames | regular | a captured run | medium | misread performance | User Guide, Command Reference (viewer / frame correlator) |
| Read the mesh-stress analysis | see which actor is stressed and how much | occasional | a committed mesh receipt | medium | misattribute contention | Command Reference (`Open Mesh-Stress Calibration` / `Open Concurrent Mesh Board`) |
| Compare across planes | judge OS / hardware / version differences objectively | occasional | runs on ≥ 2 planes | medium | unfair comparison | Command Reference (cross-plane commands), Glossary |
| Verify a release before install | refuse an unattested / un-logged release | per release | a release artifact + provenance | low (fail-closed) | install an unverified artifact | Command Reference (`Verify Release Provenance` / `Run Corroboration Grid`) |
| Drive the extension as an agent | let an agent orchestrate the above | high | MCP server reachable | medium | agent cannot operate the actor | `AGENTS.md`, MCP tool docs |

## Content decisions driven by this model

| Surface | Included because | Boundary note |
| --- | --- | --- |
| [Getting Started](./getting-started.md) | community members need a fast, task-first path to a first benchmark | not a full manual; deep procedures stay in the User Guide + route docs |
| [Command Reference](./command-reference.md) | members, agents, and maintainers need a stable quick-reference of every command | stays compact; behavior detail stays in the User Guide |
| [FAQ](./faq.md) | recurring questions need short answers without re-reading everything | stable answers fold back into the governed docs |
| [Glossary](./glossary.md) | the domain terms (actor, mesh, mprr, exact-12-FPS) need one definition source | terms trace to the requirements + architecture |
| [Delivery Profile](./delivery-profile.md) | this product delivers information in-editor (webviews / walkthrough) + via MCP, not only as prose | printed / translated / voice surfaces are out of scope |

Exclusions justified by the same model: translated deliverables, rich media, and
voice/chatbot surfaces are outside the current audience + delivery model (see the
[Conformance Boundary](./conformance-boundary.md)).
