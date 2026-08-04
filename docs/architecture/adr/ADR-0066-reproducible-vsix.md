# ADR-0066: The byte-reproducible extension package — the reviewed .vsix equals the shipped .vsix (LBA-REQ-085)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("Yes, do that" — make the vsix build byte-reproducible so a future release's reviewed artifact == shipped artifact) + agent
- Relates to: LBA-REQ-085 (realized here), LBA-REQ-071 (the composite release-decision that binds a candidate `vsixSha256` — reproducibility makes that binding stable), LBA-REQ-068 / LBA-REQ-069 (the reviewer verdict signs a candidate `vsixSha256`), LBA-REQ-001 (the standalone `.vsix` packaging boundary)

## Context

The release-review chain binds a specific artifact by its sha256: the human reviewer signs a visual PASS over a
candidate `{component, version, commit, vsixSha256}` (LBA-REQ-068/069) and the composite release-decision
(LBA-REQ-071) blocks publishing unless the tagged candidate's `vsixSha256` matches the reviewed one. That binding
silently assumed the `.vsix` is a pure function of the committed source — but it is not. `vsce package` builds the
zip with `yazl`, which stamps every entry's modification time with the *package wall-clock time* (`new Date()`),
and it does not honor `SOURCE_DATE_EPOCH`. Two `vsce package` runs of the *same commit* therefore produce
byte-different `.vsix` files: the entry names, order, compression, and content are identical, but ~72 timestamp
bytes differ, so the two artifacts have different sha256 hashes.

The consequence is that the artifact a human reviews on one machine can never be proven to equal the artifact CI
ships from another — the `vsixSha256` is a moving target rather than a stable identity for "this committed tree".
For the v1.0.0 ship this was bridged by reviewing the *exact* CI-built artifact (a single build, hand-carried),
but that does not generalize: a reviewer cannot independently rebuild and confirm the bytes, and a re-run of the
release workflow would produce a different hash than the one reviewed. Reproducibility is the missing invariant.

## Decision

- **Govern the byte-reproducible `.vsix` as LBA-REQ-085** with a pure, dependency-free post-package normalizer
  (`scripts/normalize-vsix.mjs`), a real behavioral test (`test/normalize-vsix.mjs`, run by `npm test`), and the
  gate `reproducible-vsix-normalizer` in `verify-local-gates`.
- **Pin every entry timestamp to the DOS-zip epoch (1980-01-01).** The normalizer walks the zip structure
  (End-of-Central-Directory → each central-directory record → the local file header it points to) and patches only
  the 2-byte DOS mod-time + 2-byte DOS mod-date fields to a fixed constant, leaving every other byte — names,
  order, compression, content, CRCs — untouched. It is pure Node with no dependencies so it adds nothing to the
  packaged extension and runs identically on both planes.
- **Wire it into the package pipeline** — `npm run package` runs `vsce package` and then
  `node scripts/normalize-vsix.mjs`, so the shipped artifact is always the normalized one. Because the normalized
  output depends only on the committed content (never the build time), repackaging the same committed source
  yields a byte-identical `.vsix` with a stable sha256.
- **Prove it fail-closed.** `test/normalize-vsix.mjs` builds two zips with identical content but different entry
  timestamps and asserts they normalize to byte-identical output, that normalization is idempotent, that the
  timestamp is pinned to the epoch, and that a non-zip fails closed. The gate additionally guards the wiring (the
  `package` and `test` scripts still invoke the normalizer) and re-proves the behavior synchronously on a
  hand-built zip, so the invariant cannot silently regress.

## Consequences

- **The reviewed artifact can equal the shipped artifact** — a reviewer (or CI) rebuilding the same committed tree
  now produces the same `vsixSha256`, so the LBA-REQ-071 candidate binding and the LBA-REQ-068/069 signed verdict
  refer to an artifact anyone can independently reproduce, not a one-off build. This closes the gap the v1.0.0 ship
  bridged by hand.
- **It is a minimal, content-preserving post-step** — the normalizer changes only timestamp metadata, so the
  extension VS Code installs is byte-for-byte the same functional package; only its non-functional entry mtimes are
  canonicalized. There is no fabricated content and no behavior change to the extension.
- **It composes with the existing release gates** rather than replacing them — the composite release-decision still
  binds the candidate `vsixSha256`; reproducibility simply makes that hash a stable function of the source. A
  future increment can add a release-workflow step that rebuilds and asserts the published sha256 equals the
  reviewed one end-to-end.
- The gate is DETERMINISTIC + offline (it builds a tiny in-memory zip, no `vsce` invocation at gate time),
  consistent with the rg-free / tool-free CI constraint. Authored under the singular-requirement directive (one
  `shall`).
