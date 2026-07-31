# labview-benchmark-actor — documentation package

Version-pinned **documentation guide** distributed with `lbabus`, the companion to the agent base
instructions in `lbabus agents`. Every session on the same `lbabus` version shares this identical,
byte-checked package, so documentation guidance is a single hardenable surface that iterates
version-over-version. Do not hand-edit a materialized copy — iterate the source in
`tools/collab-cli/docs/DOCS.md` and cut a new release. Verify a local copy with `lbabus docs --check <path>`.

## What this is (and is not)
- **This package** ships the *documentation posture* for the labview-benchmark-actor ecosystem: where
  the docs live, the information-item model to grow toward, and the loop for evolving them.
- It does **not** bundle the review tooling. `repo-standards-review` is a **local source
  reference** (still under construction) consulted during evolution — never distributed.
  The `mprr` ring-buffer/timing model is **absorbed in-repo** (dependency-free mirrors
  under `experiments/mprr-ring/`, ADR-0009), not an external reference. Only this
  distilled guide ships.

## Documentation map (where things live)
- `README.md` — user entry surface (install, quick start, what `lbabus` is).
- `docs/architecture/adr/` — Architecture Decision Records (the durable "why").
- `cleanroom/README.md` — the Vagrant golden-VM manual-verify lane.
- `tools/collab-cli/ci/README.md` — the Docker-CI harness that gates every release.
- `lbabus agents` / `lbabus docs` — the version-pinned agent base instructions + this guide.
- `lbabus docs show srs` / `lbabus docs show rtm` — the version-pinned requirements (SRS) + traceability
  matrix (RTM), embedded BY REFERENCE from `docs/requirements/` so they stay aligned with the build;
  `lbabus docs list` enumerates the whole bundle.

## Evolving the docs (the loop)
Documentation is hardened the same way `AGENTS.md` is (v0.6.1 → v0.6.2 …). To improve it:
1. **Assess** with `repo-standards-review` (local): the ISO/IEC/IEEE **26514** information-for-users lane,
   `run_assurance.py <repo> --profile 26514-review --output documentation-proof`. Its findings feed a
   docs PR. It is a **local driver, not a hosted gate** — the skill/image are heavy, the same reason
   real-runtime LabVIEW/Vagrant validation is a maintainer step, not hosted CI.
2. **Reference** `mprr` (absorbed in-repo under `experiments/mprr-ring/`, ADR-0009) as a
   mature exemplar — e.g. the rigor of its architecture/self-test discipline. Borrow
   structure and discipline.
3. **PR** the change to `tools/collab-cli/docs/DOCS.md` (this file). Bank recurring cross-plane findings
   on the shared hardening feedback discussion (#28), which `AGENTS.md` and docs share.
4. **Release**: the docs owner bumps `LbaBus.csproj <Version>` and cuts `collab-cli-vX.Y.Z`; the
   `ci-docs` harness stage verifies the embed round-trip + drift, then the release publishes.

## Information-item model (grow toward, as content warrants)
This guide began as a single file and has now split into a **bundle** (the same ship-thin-then-grow path
`agents` took): alongside the guide, `lbabus docs` carries the **requirements (SRS) + traceability (RTM)**,
embedded by reference from `docs/requirements/` so they iterate with — and stay aligned to — the build.
Remaining target information items to fold in as content warrants (ISO/IEC/IEEE 26514 / 15289): user
guide, quick reference, glossary, FAQ, navigation & search, information-item map, style guide,
Architecture Decision Records, test plan.

## Gate
`ci-docs` (mirrors `ci-agents`): a deterministic embed round-trip + drift check on every release, across
the whole bundle — the guide, the SRS, and the RTM each embed, round-trip (`lbabus docs show <id> --out`
then `--check` exit 0), and a tampered copy must fail (exit 3). `lbabus docs show srs --check
docs/requirements/srs.md` additionally confirms the embedded canonical matches the repo source, so the
requirements the binary carries cannot drift from the build.
