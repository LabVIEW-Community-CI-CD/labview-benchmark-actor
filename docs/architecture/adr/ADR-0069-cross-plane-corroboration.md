# ADR-0069: Genuine cross-plane corroboration — a windows-latest + ubuntu-latest witness prove two planes agree (LBA-REQ-087)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("think big; do not take shortcuts; be prescriptive" — stop deferring the windows-plane witness and DRIVE a genuine two-plane corroboration) + agent
- Relates to: LBA-REQ-087 (realized here), LBA-REQ-024 (the quorum this drives), LBA-REQ-026 / ADR-0068 (os-plane independence — this produces the genuine cross-plane evidence that correction found PENDING), LBA-REQ-086 / ADR-0067 (cross-plane byte-reproducibility — the enabler: both planes build the SAME artifact)

## Context

ADR-0068 corrected witness independence to the OS-plane and found the ACG's live corroboration to be **single-plane
(linux-only)** — genuinely cross-plane corroboration was *pending a windows-plane witness*, and no committed
witness had `os: windows`. The gap was treated as "the operator drives the Windows plane." But **GitHub Actions
`windows-latest` is a genuine Windows plane**: the extension activates and the gate suite passes there (the
`extension tests (windows-latest)` + `verify (windows-latest)` jobs are green). So a genuine windows-plane witness
can be produced automatically, in CI, from the same commit — no manual VM.

The corroboration anchor that matters cross-plane is **deterministic data, not pixels**: the viewer `seriesHash`
is the shipped viewer's projection of the committed mprr fixture, so it is identical on every plane; the pixel
render (`pngSha256`) is Linux-only and optional. Combined with the extension version, the source commit, and the
per-plane gate verdict, a linux witness and a windows witness carry the same OS-independent anchors — so the
corrected quorum (ADR-0068) reports them as genuinely cross-plane corroborated.

## Decision

- **A plane-agnostic witness producer** (`experiments/acg-quorum/produce-witness.mjs`) emits a genuine
  `acg-witness-bundle-v1` from the CURRENT plane: `os` from the platform, `version` from `package.json`,
  `sourceCommit` from the commit, `verdict` from the plane's own gate run, and `seriesHash` computed from the
  committed mprr fixture by the shipped viewer code. `pngSha256` is optional (a non-rendering plane omits it);
  `assembleWitness` and `compareWitnesses` treat a null Linux-only anchor as "not claimed", not a divergence.
- **A live two-plane workflow** (`.github/workflows/acg-cross-plane-corroboration.yml`) runs the producer on
  `ubuntu-latest` AND `windows-latest` (each after `npm test` — the plane's gate verdict) and a `corroborate` job
  runs `corroborate-planes.mjs` (the corrected quorum), FAILING CLOSED unless the two planes concur AND span
  distinct OS-planes (`crossPlane`).
- **Prove + guard it offline.** `produce-witness.selftest.mjs` proves a linux+windows pair corroborates while a
  single-plane, divergent, or non-pass pair fails closed (gate `acg-cross-plane-corroboration`); a drift gate
  (`acg-cross-plane-corroboration-workflow-wired`) keeps the workflow wired to both planes + the quorum.

## Consequences

- **The ACG delivers genuine cross-plane corroboration.** For the first time, a windows plane and a linux plane
  independently attest the same commit and are proven — live, in CI — to agree; the "pending a windows witness"
  gap (ADR-0068) is closed for the deterministic-anchor tier.
- **It is honest + automated + reproducible.** The windows witness is produced ON a real windows plane (not
  hand-written on linux), from the deterministic shipped code; there is no fabricated evidence. It re-runs on every
  release, so a plane that ever diverges (a real substrate difference) fails the corroboration closed.
- **It composes with the artifact tier.** ADR-0067 already proves the two planes build the byte-identical `.vsix`;
  this adds that they agree on the running extension's deterministic behavior. Folding the produced witnesses into
  the full grid (attestation + human sign-off) and the 1.0.0 re-seal is the natural next step. Authored under the
  singular-requirement directive.
