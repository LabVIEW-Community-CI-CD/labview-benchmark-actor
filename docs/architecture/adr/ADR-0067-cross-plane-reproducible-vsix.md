# ADR-0067: The cross-plane byte-reproducible extension package — a Windows build equals a Linux build (LBA-REQ-086)

- Status: Accepted
- Date: 2026-08-04
- Deciders: operator ("think bigger" — make the corroboration correct on the two-plane model, where a plane is the OS the extension runs in) + agent
- Relates to: LBA-REQ-086 (realized here), LBA-REQ-085 / ADR-0066 (same-plane reproducibility — this strengthens it to CROSS-plane), LBA-REQ-068 / LBA-REQ-069 / LBA-REQ-071 (the reviewed==shipped chain that now holds across planes), LBA-REQ-024 / LBA-REQ-026 / ADR-0017 (the corroboration quorum + witness-independence that this lets verify ONE identical artifact)

## Context

ADR-0066 made the `.vsix` reproducible on a *single* plane: two builds on the same machine produce the same
sha256. But the project's plane model (operator, 2026-08-04) is that **a plane is the OS the extension runs in** —
exactly two, **windows** and **linux** — and a genuine corroboration requires a windows-plane *and* a linux-plane
witness to agree. Two facts made that impossible while the `.vsix` was only same-plane reproducible:

- **The reviewed artifact was never the shipped artifact.** The human reviews on the windows plane and CI publishes
  on the linux plane; a Windows build and a Linux build of the same commit had different sha256, so the reviewed
  `vsixSha256` (LBA-REQ-068/069) could never equal the one CI shipped (the v1.0.0 defect).
- **A two-plane quorum could not corroborate ONE artifact.** Independent windows and linux witnesses would each
  compute a different artifact hash, so "the two planes agree on the same `.vsix`" was unprovable.

The cross-plane divergence has three OS-dependent sources: (1) `vsce`/`yazl` stamps each entry's **mod time** with
the package wall-clock time; (2) it writes each entry's **external file attributes** from `fs.stat` (mode `0664`
on Linux with umask `002`; a faked mode on Windows); (3) it writes a **version-made-by** host byte. Plus the
packaged **content** differs when text files are checked out CRLF on Windows vs LF on Linux (including `tsc`
output, whose `newLine` defaults to the platform).

## Decision

- **Govern the cross-plane byte-reproducible `.vsix` as LBA-REQ-086.** Building the same committed source on the
  windows plane and the linux plane must yield a byte-identical artifact (identical sha256).
- **Pin the OS-dependent zip metadata.** `scripts/normalize-vsix.mjs` (extended from ADR-0066) now pins, for every
  entry: the DOS mod-time/date (1980-01-01), the external file attributes (regular file, mode `0644`), and the
  version-made-by host (Unix) — so entry metadata no longer depends on the building plane's OS or umask.
- **Force LF on the packaged content.** `.gitattributes` pins LF on the files packaged into the `.vsix` (and the
  `experiments/` sources bundled into `out/acg-mcp-bundle`), scoped to avoid the Windows-captured experiment
  fixtures; `tsconfig.json` sets `newLine: lf` so `tsc` emits LF on every plane. The `.vsix` content is therefore
  identical regardless of a plane's `core.autocrlf`.
- **Prove it fail-closed on both planes.** `.github/workflows/vsix-cross-plane-repro.yml` builds the normalized
  `.vsix` on `ubuntu-latest` AND `windows-latest` and asserts the two sha256 are identical, failing the run when
  they diverge. The offline gate `vsix-cross-plane-repro-workflow-wired` guards that the workflow does exactly
  this and that the determinism prerequisites (`newLine: lf`, the LF `.gitattributes`) are in place.

## Consequences

- **Reviewed == shipped holds across planes.** The artifact a human reviews on the windows plane is byte-identical
  to the one CI builds and ships on the linux plane, so the LBA-REQ-085 assert (`scripts/verify-published-vsix.mjs`)
  passes with a genuine cross-plane review rather than requiring the review to happen on the publish plane.
- **A two-plane quorum can corroborate ONE artifact.** A windows-plane witness and a linux-plane witness now
  compute the same `.vsix` sha256, so the corroboration quorum (LBA-REQ-024) over two *distinct* planes
  (LBA-REQ-026, the corrected os-plane independence) attests a single identical artifact — the honest foundation
  the v1.0.0 re-seal will stand on.
- **It is content-preserving.** Only OS-dependent metadata and line endings are canonicalized; the extension VS
  Code installs is functionally identical. There is no fabricated content.
- The proof is a REAL dual-OS CI build+compare (not a synthetic argument), consistent with the project's evidence
  bar; the offline gate keeps the wiring + prerequisites from silently regressing. Authored under the
  singular-requirement directive (one `shall`).
