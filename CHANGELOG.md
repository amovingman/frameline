# Change notes

## Unreleased — experimental local build

- Added read-only FCPXML scan history, review-copy verification, Resolve snapshot review, and local collaboration/media foundations.
- Added first-run setup, cancellable scans, a reviewed path-free diagnostics export, local scan metrics, and a local review-comment store for verified immutable anchors.
- Added release policy checks, CI checks, and recovery policy tests. These do not create signed installers or enable automatic updates.

- Added service-scoped historical shared-base receipts with full ancestry verification, immutable proof snapshots, explicit retry/repair, and separate row/detail labels. Local metadata migrates to schema 5 while preserving legacy bases without treating them as service evidence.
- Added [read-only service sequence comparison](SERVICE_THREE_WAY_COMPARISON.md) between a verified shared base, current source-bound FCPXML scan, and explicitly fetched incoming history. It classifies sequence name, rational frame duration, and frame count without network access or source/history/base writes; clip/media comparison and apply remain unavailable.
- Added [Resolve service history preview](SERVICE_RESOLVE_PREVIEW.md) with independent branch mapping, complete observation transfer, and scoped base/incoming provenance. Saved-head or fresh accepted-capture sources feed the existing API-ID field/conflict review; service reviews cannot authorize the rename drill or claim current live-editor/cross-device identity.
- Added an opt-in [Rename and verify experiment](phase-0/SAFE_PULL_PREFLIGHT.md#opt-in-desktop-rename-experiments) beside the existing forced-rollback test for one reviewed clip name on a named disposable project. Version-2 issued-record guards use Fusion read-only file access; interrupted recovery explicitly restores or verifies the original observed state. Native rename/restoration were independently verified after restarts, but Console outcome acknowledgment was lost and no outcome revision was saved. Durable acknowledgment, normal Apply, and service-derived mutation remain unavailable.

Compatibility remains limited to the experimental boundary in `phase-0/SUPPORT_MATRIX.md`. No production release date or stable channel has been declared.
