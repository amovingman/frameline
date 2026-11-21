# Native result audits

The History view preserves and exposes the conflict decisions attached to each validated native Name result. This completes decision retention for the supported owner workflow: one existing video clip Name on Resolve Free 21.1.2, build 21.1.20010, on macOS. Additional incoming operations still require their own proven write rule. See [NATIVE_PULL.md](NATIVE_PULL.md).

## Review a result

Open **History → Native result audit** and refresh result history. Select an **Applied** or **Restored** revision to inspect its content hash, exact base/local/incoming checkpoint bindings, original conflict choices, source values and selected values. Decisions are paged only after the full comparison and all decision bindings have been verified.

A blocked, pending, failed or cancelled intention does not create a validated result. A previously validated Apply result remains available while a later restoration or recovery is pending. The panel separates the intention's current state from its already validated results.

Restoration preserves the decisions from the original Apply review. The restored result has its own direction, content hash and native editor proof; displaying the original incoming choice does not mean restoration made that choice again. The panel states this explicitly.

Historical verification checks authenticated retained records. It does not assert that the current open project matches that result, that a retained backup is presently available, or that another write is permitted. **History → Verify retained local records** independently checks retained backup/candidate bytes and field preservation; see [PERSONAL_SAFETY_AND_CORRECTNESS.md](PERSONAL_SAFETY_AND_CORRECTNESS.md).

## What is verified

The host reads authenticated intention and transaction journals and exact retained checkpoint bytes. It recomputes the complete three-way report, lineage, generation bindings, executable Name plan and decision audit. Every resulting native revision must retain the identical review hashes, explicit choices and source bindings. The latest validated result must also match its closed editor proof, target, content hash and original source metadata.

The UI receives opaque IDs, hashes, bounded field descriptions and safe Name/numeric values. Paths and raw opaque values stay on the host. A stored Name containing a path is represented by its typed-value hash rather than exposing the path.

This is a read-only view of the native transaction's immutable result records. It does not turn native results into FCPXML or API-observation revisions and does not modify those existing histories.

## Save an audit

**Review and save audit** shows the export's contents and SHA-256 before opening a save dialog. The host re-verifies the same result after the dialog and writes a new file exclusively; it does not overwrite an existing file.

The canonical `frameline-native-result-audit` JSON contains the revision, original Apply decision audit, exact checkpoint hashes, classified changed-field descriptions and original selected values. Project/clip names, IDs and field values can be sensitive and are disclosed in the review. Filesystem/media locations, database bytes, backup bytes and private host keys are excluded.

A standalone portable digest verifies integrity and internal relationships. It cannot establish authenticated origin on another machine and grants no Apply or restore authority. Local authenticated origin is established by reconstructing the audit from this host's retained records. An exported audit is not a project backup or restore point.

## Validation evidence

The automated desktop proof starts two real Electron processes with shipped main, preload, renderer and authenticated readers. A disposable SQLite fixture creates a Name conflict plus an unsupported Flags conflict, applies **take incoming** for Name and **keep local** for Flags, and validates both Apply and restoration. The proof inspects both resulting revision audits after restart, exercises the review/save dialogs, verifies canonical exports, checks source bytes remain unchanged by review and captures visible History panels at 1440px and 600px. Hardware, publication and editor observations in this automated proof are synthetic. See [desktop verification](phase-0/native-result-audit-desktop/verification.json).

The separate native proof used the owner's small disposable Resolve project and four independently admitted editor readbacks with post-close validation:

| Stage | Result | Transaction |
| --- | --- | --- |
| Guarded staging | B → local E | `cc6690a4-7af6-4ed2-aaf6-1decc189c373` |
| Native conflict Apply | E → D, explicit incoming Name choice | `6cc5e836-cf5c-4b89-9a9e-779f18c31c6d` |
| Native restoration | D → E, original choice retained | `6cc5e836-cf5c-4b89-9a9e-779f18c31c6d` |
| Guarded final restoration | E → exact original B | `cc6690a4-7af6-4ed2-aaf6-1decc189c373` |

The native intention is `40c833d3-7ef4-4650-a86d-ece258ff743a`. Its Apply and restored-result exports each retain exactly one explicit Name conflict choice and the original B/E/incoming-D values. The native result D hash differs from the historical incoming D hash; the auditor verifies matching stored application values for this fixture and keeps both raw hashes distinct. The original B bytes were restored and the incoming D bytes remained unchanged.

The [native receipt](phase-0/native-result-live-proof.json) is reconstructed from authenticated journals, historical completed events, exact portable exports and independently recomputed full-cell comparisons. Private authorities, keys and database bytes remain in the ignored owner evidence directory. The audit never calls recovery against historical local E after B has been restored. Fresh source checks use original B and the unchanged incoming D, with Resolve closed and the recorded library configuration restored.

No evidence here establishes general field writes, media portability, cross-device identity, opaque structure semantics or exclusion of an external writer.

## Commands

```sh
npm run test:personal-gates
npm run verify:result-audits
npm run verify:local-integrity
npm run audit:native-result-live
```

The desktop verifiers use disposable fixtures. The native auditor requires the owner's ignored retained evidence and fresh read-only visibility of the installed editor/library environment. `node scripts/audit-native-result-live.cjs --write-receipt` rebuilds a maintainer receipt from those authorities; its source-pin map must be filled from the final reviewed implementation before the normal audit accepts it. None of these verification commands replay an edit or restore the owner’s existing Resolve project.
