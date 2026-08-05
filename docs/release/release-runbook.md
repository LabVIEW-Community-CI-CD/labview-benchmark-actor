# Release runbook — labview-benchmark-actor (concrete, agent-executable)

> The **step-by-step, copy-pasteable** end-to-end sequence for a governed Marketplace
> release, captured verbatim from the 1.1.1 publish. The companion
> `docs/release/release-procedure.md` is the ISO/IEC/IEEE 15289 *procedure* (the
> normative "what + why"); this runbook is the concrete *how* — the exact commands,
> artifact locations, and ordering an operator or future agent runs. Every repo path
> named below in backticks resolves on disk (fail-closed via the
> `release-runbook-references-resolve` gate); the ephemeral staging artifacts live in
> `~/lba-vm-share/` on the operator host, **not** in the repo.
>
> The `lba release` orchestrator (issue #409) will eventually execute this runbook
> resumably, preflighting each gate; until then this file is the manual source of truth.

## 0. Prereqs

- **Build/review on the pinned node.** The published `.vsix` is byte-reproducible only
  within an exact node version, so the whole release path is pinned by the repo-root
  `.nvmrc` (issue #408). Run `nvm use` (or install that exact version) before packaging;
  the release-path workflows source it via `node-version-file: .nvmrc`.
- **Reviewer VM up.** The `actor` reviewer VM is running with the enrolled reviewer key
  present in the VM (issue #414), and the guest-side scripts under `reviewer-workstation/`
  are reachable.
- **Host credentials + share.** `~/.config/lba/vm-pass` holds the VM password; the shared
  drop folder `~/lba-vm-share` exists (staging artifacts land here).

## 1. Cut the candidate

1. Cut `release/X.Y.Z` from `develop` (GitFlow; only release/hotfix heads may target
   `main`).
2. Bump `version` in `package.json` to `X.Y.Z` and stamp the `## [X.Y.Z]` section in
   `CHANGELOG.md`.
3. On the pinned node, build the normalized artifact: `npm run package`. Capture the
   candidate `commit` and the packaged `vsixSha256`.
4. **Re-`npm run package` after every later seal/back-merge commit and assert the sha is
   unchanged** — the packaged file set must not move once reviewed (normalization is
   proven by `scripts/normalize-vsix.mjs`).

## 2. Machine half — cross-plane corroboration

1. Dispatch the corroboration grid at the candidate commit:
   `.github/workflows/acg-cross-plane-corroboration.yml` (`workflow_dispatch`, `--ref`
   the candidate commit). This runs genuine ubuntu + windows runners as the two OS
   planes.
2. Download the witnesses and build + validate the attestation, dropping it at
   `~/lba-vm-share/attestation-X.Y.Z.json`. The byte-reproducibility of the `.vsix`
   across planes is separately guarded by `.github/workflows/vsix-cross-plane-repro.yml`.

## 3. WIN plane validation

Run `reviewer-workstation/win-plane-validate.sh` for `release/X.Y.Z` (drives
`reviewer-workstation/win-plane-validate.ps1` in the VM): `npm ci` + compile + the test
suites + masked activation + the packaging gate, landing on `winPlaneReady:true`. The
candidate `.vsix` is staged in the VM (sha verified) via
`reviewer-workstation/stage-local-vsix.ps1`.

## 4. Signing (the two human sign-offs, in the VM)

The enrolled reviewer key lives in the VM (issue #414), so signing happens guest-side:

1. **Visual verdict.** Point the renderer at the target and stage the candidate with
   `reviewer-workstation/render-verdict.sh` (`set-target`, then `collect` after the
   in-VM "Render Reviewer Verdict"). The reviewer's PASS is Ed25519-signed by
   `reviewer-workstation/sign-visual-verdict.mjs` (issue #411) → a
   `visual-verdict-X.Y.Z.json` record in `~/lba-vm-share/`.
2. **Machine quorum sign-off.** Sign the cross-plane quorum verdict with
   `reviewer-workstation/sign-release-quorum.mjs` in the VM (issue #415). (Note the
   guestcontrol `cmd /c` node-invocation gotcha when driving node inside the guest.)
3. Verify both locally before sealing: `tools/collab-cli/verify-visual-review.mjs` and
   the composite verifier `tools/collab-cli/verify-composite-release.mjs`.

## 5. Seal — receipt + agreement

1. **Composite receipt.** Assemble the composite release-decision receipt with
   `reviewer-workstation/composite-release-decision.mjs`, writing
   `reviewer-workstation/composite-release-decision-receipt.json` with `candidate.version
   == X.Y.Z`. That committed `candidate.version` is the **single source of truth** for the
   enforced version (issue #416) — no gate file hardcodes a version, so the bump touches
   only this receipt (+ `package.json` + `CHANGELOG.md`).
2. **Record the agreement.** Instead of hand-editing JSON, run the recorder (issue #419):

   ```
   node tools/collab-cli/record-release-agreement.mjs \
     --component extension --version X.Y.Z --commit <sha> \
     --linux-note "..." --win-note "..." \
     --visual-verdict ~/lba-vm-share/visual-verdict-X.Y.Z.json
   ```

   It inserts the `components.extension.releases.<version>` entry (both planes
   `agreed:true` + the embedded signed `visualReview`) as a minimal structured edit into
   `tools/collab-cli/release-agreement.json`, refuses to clobber an existing version, and
   fails closed unless `tools/collab-cli/verify-release-agreement.mjs` +
   `tools/collab-cli/verify-visual-review.mjs` both pass for that version.
3. **Preflight.** `npm run lba -- release-preflight X.Y.Z` must be all green: it asserts
   the local node equals `.nvmrc`, `package.json` + `CHANGELOG.md` are at `X.Y.Z`, the
   composite receipt `candidate.version == X.Y.Z`, and the three live publish gates clear
   (`scripts/lba.mjs`).

## 6. Reconcile + merge to main

1. Merge `origin/main` into the release branch to absorb any divergence (issue #417),
   resolving the sealing files (`reviewer-workstation/composite-release-decision-receipt.json`,
   `tools/collab-cli/release-agreement.json`) with `--ours`; verify no main-unique commit
   is lost.
2. Open the PR to `main` and merge with `--no-ff` (never squash a release), so
   `main` ↔ `develop` never diverge (`docs/cm/cm-plan.md`).

## 7. Publish

1. Dispatch `.github/workflows/extension-release.yml` (`workflow_dispatch`,
   `-f version=X.Y.Z`, `--ref main`). The `agreement` job runs
   `tools/collab-cli/verify-composite-release.mjs --component extension X.Y.Z` and blocks
   the publish unless the committed composite decision proves both gates for the tagged
   candidate. Watch until it reports `Published … vX.Y.Z` (the `VSCE_PAT` secret authorizes
   the Marketplace push).
2. Confirm reviewed == shipped: `scripts/verify-published-vsix.mjs` asserts the CI-built
   `.vsix` sha256 equals the reviewed `vsixSha256`.
3. Cut the immutable GitHub Release from the signed artifact: download the
   `ext-vsix-signed-X.Y.Z` build artifact, then
   `gh release create ext-vX.Y.Z <assets> --notes-file <changelog section> --target main`
   (an authorized bypass token is needed to push the protected `ext-v*` tag).

## 8. Close out

1. Back-merge the release tip to `develop` with `--no-ff` (issue #417) so the version
   bump, receipt, and agreement return to integration.
2. Assert `git merge-base --is-ancestor <release-tip> main` **and** `… develop` — the
   release tip is an ancestor of both, so the planes stay in sync.
3. Re-check the Marketplace listing (the gallery API lags a few minutes) and record the
   closeout in the regenerated `docs/testing/test-report.md` counts.

## Artifact + credential map

| Item | Location |
| --- | --- |
| Node pin | `.nvmrc` (sourced by every release-path workflow) |
| Cross-plane attestation | `~/lba-vm-share/attestation-X.Y.Z.json` (host) |
| Signed visual verdict | `~/lba-vm-share/visual-verdict-X.Y.Z.json` (host) |
| Composite receipt (committed) | `reviewer-workstation/composite-release-decision-receipt.json` |
| Release agreement (committed) | `tools/collab-cli/release-agreement.json` |
| Marketplace publish credential | `VSCE_PAT` secret (CI) |
| `ext-v*` tag push | an authorized bypass token (protected tag) |
