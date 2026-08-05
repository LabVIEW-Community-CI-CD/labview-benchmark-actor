# Release procedure — labview-benchmark-actor

> ISO/IEC/IEEE 15289 **procedure** information item and the ISO/IEC/IEEE 12207 /
> ISO 10007 **release process** for this repository. The configuration management
> *plan* (`docs/cm/cm-plan.md`) states the policy (GitFlow, baselines, status
> accounting); this document is the step-by-step *procedure* that executes a
> signed, corroborated release. Every enforcement point named below is a real
> workflow, gate, or script in this repository, and the
> `release-procedure-references-resolve` gate (LBA-REQ-036) fails closed if any of
> them stops resolving, so this procedure cannot rot away from the apparatus.

## Scope

Two artifacts are released from this repository, each on its own SemVer tag
namespace on the protected `main` branch:

- the **VS Code extension** `.vsix` — tag `ext-vX.Y.Z`, workflow
  `.github/workflows/extension-release.yml`;
- the **collab-cli / lbabus** bus binaries + package — tag `collab-cli-vX.Y.Z`,
  workflow `.github/workflows/collab-cli-release.yml`.

Both publishes are **fail-closed** behind the bidirectional WIN ↔ LINUX agreement
gate (LBA-REQ-020) and carry keyless provenance recorded in the signed
transparency log (LBA-REQ-031). No release is installable until its corroboration
attestation is proven included in that log.

## Preconditions

- The change set is merged to `develop` and green: `verify-local-gates` (all
  checks), `coverage`, `dod`, and `Docs Link Check / lychee` pass on `develop`.
- The version to release is decided (SemVer) and, for the extension, will match
  `version` in `package.json`.
- **Build/review on the pinned node (LBA-REQ-085, issue #408).** The published
  `.vsix` is byte-reproducible only within an exact node version, so the release
  path is pinned by the repo-root `.nvmrc`. Run `nvm use` (or install that exact
  version) before packaging; every release-path workflow sources the same pin via
  `node-version-file: .nvmrc`. **To bump the pinned node**, edit `.nvmrc` to the new
  exact `X.Y.Z`, re-`npm run package` to confirm the reviewed sha still matches CI,
  and re-run the byte-repro grid — the pin is the single source; no workflow edits are
  needed.
- Enrolled corroboration witnesses (at least the quorum minimum, from distinct
  environments per LBA-REQ-026) are available to attest.

> **Concrete sequence:** the copy-pasteable, agent-executable end-to-end steps (exact
> commands, artifact locations, and ordering, captured from the 1.1.1 publish) live in
> the companion runbook `docs/release/release-runbook.md`.

## Procedure

1. **Cut the release branch (GitFlow, LBA-REQ-016, ADR-0010).** Create
   `release/X.Y.Z` from `develop`. Only release/hotfix heads may target `main`
   (`pr-base-branch-guard`, LBA-REQ-030).
2. **Set the version.** Bump `version` in `package.json` (extension) to `X.Y.Z`
   on the release branch; commit with a single-quoted message.
3. **Merge to `main` with a merge commit.** Merge `release/X.Y.Z` into `main`
   using `--no-ff` (never squash a release — see `docs/cm/cm-plan.md`, "Merge
   method by branch type"), preserving shared ancestry so `main` ↔ `develop`
   never diverge.
4. **Corroborate across planes (LBA-REQ-023–028).** Run the corroboration grid so
   each enrolled witness attests the exact built artifact; assemble the witnesses
   and compute the quorum + graded confidence (LBA-REQ-024). The grid is exercised
   offline by the `acg-*` gates and, over the mesh, by the verdict beacon
   (LBA-REQ-028).
5. **Record the bidirectional sign-off (LBA-REQ-020).** The `.vsix` / bus release
   publishes only after **both** the WIN and LINUX planes record an agreed
   sign-off for that exact version — the agreement gate in
   `.github/workflows/extension-release.yml` (and `collab-cli-release.yml`) is the
   enforcement point.
6. **Keyless-sign the artifacts (LBA-REQ-025, ADR-0016).** CI keyless-signs each
   staged artifact with cosign — a short-lived Fulcio certificate bound to the
   workflow identity, with the signature recorded in the **public rekor**
   transparency log — via `.github/workflows/acg-keyless-attest.yml` and the
   `./.github/actions/keyless-attest` action. Correct wiring is drift-gated
   offline by `acg-keyless-attest-workflow-wired`.
7. **Log the attestation (LBA-REQ-031, ADR-0022).** Each witness attestation is
   recorded as a leaf in the signed Merkle transparency log
   (`experiments/acg-transparency/transparency-log.mjs`, RFC 6962), producing an
   inclusion proof against the signed tree head.
8. **Cut the immutable GitHub Release.** A maintainer creates the immutable
   release with the signed assets attached at creation:
   `gh release create ext-vX.Y.Z staging/*` (or `collab-cli-vX.Y.Z`). Attaching
   the signed `.vsix` (+ `.sigstore` / `.pem` / `.sig`) at creation keeps the
   release immutable-safe. The retained `push: tags: ext-v*` trigger is dormant
   under branch protection; `workflow_dispatch` is the live build/stage path.
9. **Verify before install (LBA-REQ-031).** Consumers admit a release only after
   `experiments/acg-transparency/verify-release-inclusion.mjs` proves at least the
   quorum minimum of enrolled-witness attestations are each included in the signed
   log; a missing or tampered proof blocks the install. This is wired fail-closed
   into `reviewer-workstation/provision.ps1` before the `.vsix` install
   (`acg-transparency-verify-before-install-wired`).
10. **Merge back and close out.** Merge `release/X.Y.Z` into `develop` (`--no-ff`)
    so the version bump and any release fixes return to integration; delete the
    release branch after both merges complete. Record the release (source commit,
    tag, corroboration result) as status-accounting closeout in
    `docs/testing/test-report.md`'s regenerated counts and the CM discussion
    thread (`docs/cm/cm-plan.md`, "Status accounting").

## Rollback

- A release that fails verify-before-install is **not** installable by design — no
  rollback of consumers is required; the un-attested or un-logged release is
  refused at step 9.
- To supersede a bad tag, cut the next patch (`X.Y.Z+1`) through this same
  procedure. Tags on `main` are immutable and CI-owned; they are never force-moved.

## Enforcement summary

| Step | Invariant | Enforcement point |
| --- | --- | --- |
| 1 | Only release/hotfix heads reach `main` | `pr-base-branch-guard` (LBA-REQ-030) |
| 3 | `main` ↔ `develop` never diverge | `--no-ff` merge (cm-plan) |
| 5 | Both planes agree the exact version | agreement gate in `extension-release.yml` (LBA-REQ-020) |
| 6 | Artifacts keyless-signed (Fulcio + rekor) | `acg-keyless-attest.yml`, `acg-keyless-attest-workflow-wired` (LBA-REQ-025) |
| 7 | Attestation logged, tamper-evident | `experiments/acg-transparency/transparency-log.mjs` (LBA-REQ-031) |
| 9 | Only quorum-attested + logged releases install | `experiments/acg-transparency/verify-release-inclusion.mjs`, `acg-transparency-verify-before-install-wired` (LBA-REQ-031) |
