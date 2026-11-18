# Change notes

## Unreleased — experimental local build

- Added read-only FCPXML scan history, review-copy verification, Resolve snapshot review, and local collaboration/media foundations.
- Added first-run setup, cancellable scans, a reviewed path-free diagnostics export, local scan metrics, and a local review-comment store for verified immutable anchors.
- Added release policy checks, CI checks, and recovery policy tests. These do not create signed installers or enable automatic updates.

- Added service-scoped historical shared-base receipts with full ancestry verification, immutable proof snapshots, explicit retry/repair, and separate row/detail labels. Local metadata migrates to schema 5 while preserving legacy bases without treating them as service evidence.
- Added [read-only service sequence comparison](SERVICE_THREE_WAY_COMPARISON.md) between a verified shared base, current source-bound FCPXML scan, and explicitly fetched incoming history. It classifies sequence name, rational frame duration, and frame count without network access or source/history/base writes; clip/media comparison and apply remain unavailable.

Compatibility remains limited to the experimental boundary in `phase-0/SUPPORT_MATRIX.md`. No production release date or stable channel has been declared.
