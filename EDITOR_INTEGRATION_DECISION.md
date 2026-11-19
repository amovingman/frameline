# Editor integration reassessment — November 19, 2026

**Decision: stop promotion to a supported writing release; retain the exact Resolve Free 21.1.2 read-only experiment.** This is the completed stop/revisit decision. It is not evidence that clip/track identity or safe validation has become achievable. Those capability gates remain blocked.

Run `node phase-0/revisit-editor-choice.js` to recompute the current first-editor evidence audit and the decision’s hash-bound record. The script checks named, checked-in disposable captures and reports exact evidence/document hashes. It does not contact an editor, alter project bytes, infer pilot consent, or grant release/write authority. A missing or incompatible evidence set fails instead of being promoted.

## Why release work stops here

The current first-editor audit still records an unavailable external API connection in the observed Free installation, incomplete construct coverage, unproven persistent track identity and API-to-export mapping, unobserved native fields, and unexplained native-content changes even in a no-edit save/reopen control. Repeated-media occurrence IDs and guarded disposable rename/recovery experiments are valuable evidence, but they do not establish a general safe merge.

The [integration assessment](phase-0/INTEGRATION_ASSESSMENT.md), [readiness audit](phase-0/FIRST_EDITOR_READINESS.md), [support matrix](phase-0/SUPPORT_MATRIX.md), and recomputed [first-editor audit](phase-0/audit-first-editor.js) support this decision. Their status does not change merely because the decision procedure is complete.

## Alternatives revisited

| Path | Decision | Evidence and consequence |
|---|---|---|
| Free 21.1.2 / FCPXML 1.10 | Retain read-only | Bounded picture scanning and revision inventory work. Export identity and complete round-trip preservation are unproven. |
| Free internal Lua Console | Research only | Read-only capture and guarded disposable rename/recovery work for represented fixtures. Complete live state, track identity, and general apply remain unproven. |
| Studio external scripting | Not selected | A different edition/license and independently tested corpus/integration would be required. No Studio compatibility is inferred. |
| Another editor | Not selected | No release-ready candidate or consented first-user evidence exists. This reassessment starts no second adapter. |
| Native project-byte patching | Rejected | Opaque native content is not a supported edit schema. Native exports remain candidate backup artifacts. |

The current product keeps ordinary project apply unavailable. `assessCompatibility()` still returns `releaseSupported: false` and `writeSupported: false`, including for the exact experimental target. Existing separately opted-in disposable research drills retain their narrow gates; they are not promoted to an ordinary writing feature.

## Conditions for reconsideration

Before a supported writing target is selected, obtain consented first-user edition/build/OS and representative-project evidence; complete the construct inventory; prove persistent item/track identity and unambiguous project/export mapping; resolve lossless-field and native-content equivalence gaps; and demonstrate a recoverable transaction with verified restore point, supported API write, reopen validation, and interrupted recovery on representative projects. Evaluate a different editor or edition only against those same gates.

The machine-readable decision in [phase-0/editor-integration-decision.json](phase-0/editor-integration-decision.json) records this result, its alternatives, blockers, reopening criteria, and enforcement checks. It preserves path-free evidence provenance without publishing private project content.
