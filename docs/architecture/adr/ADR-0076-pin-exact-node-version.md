# ADR-0076: Pin the exact Node.js version across release-path workflows — the third leg of `.vsix` reproducibility (LBA-REQ-093)

- Status: Accepted
- Date: 2026-08-05
- Deciders: the release-tooling seamless-release epic (#421, quick-win #408) + agent
- Relates to: LBA-REQ-093 (realized here), LBA-REQ-085 / ADR-0066 (the timestamp pin — first leg), LBA-REQ-086 / ADR-0067 (the cross-plane metadata + LF pin — second leg), LBA-REQ-071 (the composite decision that binds the reviewed `vsixSha256`)

## Context

ADR-0066 (LBA-REQ-085) pins every packaged `.vsix` entry timestamp and ADR-0067 (LBA-REQ-086) pins the OS-dependent
zip metadata + forces LF, so repackaging the same committed source yields a byte-identical artifact and a Windows
build equals a Linux build. That makes the reviewed `vsixSha256` provably equal to the shipped one — **but only
within an exact Node.js version**. The packaged bytes are a function of the toolchain, and a Node **minor** can
perturb them. Every release-path workflow pinned `actions/setup-node@v5` with `node-version: '24'`, which resolves
to whatever latest 24.x is in the runner tool cache at run time. The reviewed sha is built locally on a fixed 24.x;
if CI later floats to a different 24.x whose bytes differ, the `reviewed==shipped` gate
(`reviewed-vsix-matches-shipped`, LBA-REQ-085) fails at **publish** — the most expensive place to discover it. The
1.1.0 release already hit the coarse version of this (a node-22 review vs a node-24 publish produced different
shas); that major-level lesson is folded into `lba release-preflight`, but the residual minor-drift risk was
uncommitted.

## Decision

- **Govern the Node-version pin as LBA-REQ-093.** A repo-root `.nvmrc` pins the **exact** release Node version
  (`24.19.0`), not a major.
- **Every release-path workflow sources Node from `.nvmrc`.** `.github/workflows/extension-release.yml`,
  `.github/workflows/vsix-cross-plane-repro.yml`, and `.github/workflows/acg-cross-plane-corroboration.yml` use
  `node-version-file: .nvmrc` and pin no floating `node-version:` literal, so the local reviewed build and the CI
  publish build resolve the **same** Node.
- **`lba release-preflight` enforces the pin locally.** Its node-major check is upgraded to an exact-version check
  that fails closed unless the local Node equals `.nvmrc` (when `.nvmrc` is present).
- **The gate `release-path-node-pinned`** proves, offline + deterministically, that `.nvmrc` pins an exact version
  and every release-path workflow sources it from `.nvmrc` with no floating literal; the `scripts/lba.mjs` selftest
  proves the exact-version preflight (an equal Node clears, a later 24.x minor fails).

## Consequences

- **Reproducibility is complete across all three axes:** timestamp (ADR-0066) + OS metadata/LF (ADR-0067) + Node
  version (this ADR). The reviewed and shipped `.vsix` cannot diverge from a toolchain drift the review never saw.
- **The pin is the single source.** Bumping the release Node is one edit to `.nvmrc`; no workflow edits are needed,
  and the `release-path-node-pinned` gate keeps the workflows honest to it.
- **`[Assumption]`** the exact-version pin is sufficient for byte-identity in practice; if a patch-level Node ever
  perturbs the packaged bytes, the `reviewed-vsix-matches-shipped` + `vsix-cross-plane-repro` gates still fail
  closed, so the pin tightens the review loop but is not the sole backstop.

## References

- Realizes: LBA-REQ-093 (`docs/requirements/srs.md`, `docs/requirements/rtm.csv`, test `T-093`)
- Extends: ADR-0066 (timestamp pin), ADR-0067 (cross-plane metadata + LF)
- Procedure: `docs/release/release-procedure.md`, `docs/release/release-runbook.md` (the pin + bump procedure)
- Standards baseline: repo-standards-review (the authoritative standards lens for this repo, ADR-0010)
