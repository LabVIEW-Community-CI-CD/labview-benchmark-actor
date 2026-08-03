# Command Reference

> Every **LabVIEW Benchmark Actor** command contributed to the VS Code Command
> Palette, grouped by task. Aligns to **ISO/IEC/IEEE 26514:2022 §5** (reference
> information). This surface is kept **complete** by the `information-for-users-26514`
> gate, which fails closed if a contributed command is missing here.
> Command IDs are prefixed `labviewBenchmarkActor.`.

## Host and coordination bus

| Command | ID | What it does |
| --- | --- | --- |
| **Show Host Capabilities** | `showCapabilities` | Report what the actor sees on this host (local only). |
| **Poll Coordination Bus** | `pollBus` | Read recent messages from the `lbabus` coordination bus. |
| **Post Coordination Note** | `postNote` | Post an inter-actor note to the bus (communication only; never run data). |

## Benchmark capture and review

| Command | ID | What it does |
| --- | --- | --- |
| **Capture LabVIEW Launch** | `captureLaunch` | Record the screen at exactly 12 FPS + sample CPU/RAM/disk while LabVIEW launches (VM-local). |
| **Stop LabVIEW Capture** | `stopCapture` | Stop the active capture and assemble the launch record. |
| **Open Benchmark Frame Correlator** | `openFrameCorrelator` | Scrub a time cursor across the metric curves + the captured screenshot at each frame. |
| **Open Benchmark Viewer** | `openViewer` | Open the time-cursor benchmark viewer on the shipped series. |
| **Open Benchmark Run** | `openBenchmarkRun` | Render one captured LabVIEW-launch run. |
| **Open Benchmark Trend** | `openBenchmarkTrend` | Render the multi-run launch trend. |

## Handoff Beacon (agent&#8596;human)

> When the agent asks you to perform a manual step in the reviewer VM (run a VI,
> activate LabVIEW, click Stop), it surfaces as a notification with **Mark step
> done** / **Skip** buttons; these commands do the same from the palette. Your
> answer is written as a machine-readable `op-done` beacon the agent awaits, so it
> resumes without re-asking (LBA-REQ-056, ADR-0036).

| Command | ID | What it does |
| --- | --- | --- |
| **Mark Handoff Step Done** | `markStepDone` | Answer the agent's pending handoff request as done (writes the op-done beacon the agent awaits); prompts for an optional note. |
| **Skip Handoff Step** | `skipStep` | Decline the agent's pending handoff request (writes an op-done beacon with a `skipped` outcome). |

## Cross-plane and resource

| Command | ID | What it does |
| --- | --- | --- |
| **Open Cross-Plane Benchmark Trend** | `openCrossPlaneTrend` | Compare the launch trend across the WIN and LINUX planes. |
| **Open Benchmark Resource Profile** | `openResourceProfile` | Show the CPU/RAM/disk resource correlation for a run. |
| **Open Cross-Plane Resource Agreement** | `openCrossPlaneResource` | Show how the two planes agree on resource cost. |

## Mesh-stress analysis

| Command | ID | What it does |
| --- | --- | --- |
| **Open Mesh-Stress Calibration** | `openMeshCalibration` | Render the stress-ladder calibration curve + invariants + inverse-read. |
| **Open Concurrent Mesh Board** | `openMeshBoard` | Render a live board of N simultaneously-stressed actors and their inferred stress. |

## Agent instructions

| Command | ID | What it does |
| --- | --- | --- |
| **Write Agent Instructions** | `writeAgents` | Materialize the extension-embedded `AGENTS.md`. |
| **Show Agent Instructions** | `showAgents` | Open the embedded agent instructions read-only. |
| **Check Agent Instructions** | `checkAgents` | Verify the embedded `AGENTS.md` integrity manifest. |

## Provisioning

| Command | ID | What it does |
| --- | --- | --- |
| **Create Cleanroom Worker VM** | `createCleanroom` | Scaffold a cleanroom worker VM for delegated work. |
| **Bootstrap LabVIEW Authoring Lane (Windows)** | `bootstrapAuthoringLane` | Bootstrap the Windows LabVIEW authoring lane. |

## Release corroboration

| Command | ID | What it does |
| --- | --- | --- |
| **Run Corroboration Grid** | `runCorroborationGrid` | Run the multi-witness Actor Corroboration Grid end-to-end. |
| **Verify Release Provenance** | `verifyReleaseProvenance` | Verify the attestation chain before installing a release. |

## Agent surface

Every panel command above is also openable by an agent through the
`lba-open-benchmark-panel` **language-model tool** (`panel = run | trend |
frameCorrelator | crossPlaneTrend | resourceProfile | crossPlaneResource |
meshCalibration | meshBoard`), and the actor's core tools are exposed over the
Model Context Protocol server. See [`AGENTS.md`](../../extension-agents/AGENTS.md)
and [Delivery Profile](./delivery-profile.md).
