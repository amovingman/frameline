# Deletion conflicts and timeline ordering rules

These complete two Phase 2.2 roadmap items in the supported Resolve observation review: treating local edits versus incoming deletion as a conflict, and defining ordering rules for concurrent additions and moves. The rules are integrated into the existing desktop review for local files, local revision history, and service-backed history. Applying a general pull remains a separate roadmap item.

## Deletion cannot silently discard an edit

The classifier matches represented entities by their observed Resolve IDs. If one side deletes a clip or timeline and the other side changes its represented state, it produces one whole-entity `existence` conflict. The rule is symmetric: incoming deletion versus local edit, and local deletion versus incoming edit. Renames, timing, source identity, links, effect/property observations, track-state observations, and changes to a deleted timeline’s children remain part of the retained entity comparison.

The selected-change panel explains which side deleted the entity, lists the represented changed fields, and shows all three entity values. Absence is labeled **Not present in this cut**. Both choices have an explicit consequence:

| Conflict | Keep local | Take incoming |
|---|---|---|
| Local edit, incoming deletion | Retain the edited local entity in the review | Record deletion, discarding the represented local edits in a future supported apply |
| Local deletion, incoming edit | Keep the local deletion | Record restoration with the incoming entity’s represented edits |

A review audit requires an explicit choice for every conflict. Saving a choice changes neither source bytes nor editor state. Whole-entity choices keep the exact selected value in the existing immutable audit. Missing observations are unknown; the changed-field explanation never claims complete editor equivalence. Field explanations have per-conflict count/byte limits and a shared byte budget, with exact omitted-field counts.

## Ordering policy

Each source’s observed placements remain separate. The policy never fabricates a merged timeline, changes neighbors, or silently resolves ordering by item ID.

| Situation | Rule |
|---|---|
| Known intervals | Use absolute integer frames and half-open intervals `[start, end)`. Touching endpoints are adjacent, not overlapping. |
| Concurrent additions at the same position | Require joint manual review; there is no arbitrary ID, branch, or arrival-order winner. |
| Different concurrent placements of one retained ID | Require source/conflict review. Independent field choices do not establish a valid combined interval. |
| Cross-side additions or moves overlap | Display the source side, item IDs, observed track, and overlapping frame interval. Require joint review. |
| A changed placement overlaps an unchanged neighbor | Include the neighbor from the full source inventory, even if it has no diff row. Require joint review. |
| Known nonoverlapping placements | Report their observed independence without granting automatic merge or apply authority. |
| Track layout or timeline origin changes | Show a timeline review. Track indexes do not establish persistent identity. |
| Unknown/invalid intervals | Exclude those intervals from overlap calculations, report incomplete analysis, and require additional manual review. |
| Links, effects, nested content, ripple behavior | Preserve the risk warning. Never infer gap adjustment, neighbor shifts, linked-media movement, or ripple operations. |

The report sorts deterministically for review. That order is presentation only. Each change retains separate base/local/incoming placements and a placement-only status. Timeline changes include all three observed track layouts. Overlap records identify each item’s source side, so opposite source combinations remain distinguishable.

Overlap analysis uses a sweep with expiring intervals, includes unchanged blockers, and stops at an explicit comparison budget. Unchanged-versus-unchanged pairs are not exhaustively enumerated. Defaults bound displayed changes/interactions to 500 each, pair comparisons to 100,000, and report rows to a 2 MiB budget. Counts distinguish analyzed results from shown rows; comparison-limited interaction counts are lower bounds. The UI shows 12 records per page with timeline filtering, keyboard-operable navigation, and explicit incomplete/truncated messaging.

## Source binding and existing history

The main-process review session derives both policies from the exact three verified source byte streams, caches a separate guidance artifact, and gives it a deterministic SHA-256 plus all three source fingerprints. Source refresh recomputes guidance and resets choices when the bytes change, including formatting-only changes. Invalid sources and explicit review clearing remove retained guidance. Public state contains detached guidance, not private source bytes or paths.

Canonical preview plans, conflict IDs, saved-review artifacts, and immutable audit hashes keep their existing formats. Recovering an older verified review regenerates the new explanations from its exact sources. Existing saved decisions and audits retain their identities. Service-derived reviews retain their read-only provenance and cannot authorize the experimental rename drill.

## Verification

- `npm run test:conflict-policy` verifies symmetric deletion rules, supplements and semantic equivalence, consent/audit recovery, bounded metadata, interval ordering, unchanged blockers, deterministic permutations, randomized comparison against direct pair enumeration, dense-work limits, source-bound guidance, and legacy review identities.
- `npm run verify:conflict-policy` runs the shipped main process, preload, and renderer in two real Electron processes with a disposable profile and fixture-supplied OS picker results. It checks explicit consequences, required review choices, unchanged source bytes, saved audit/guidance recovery, source-refresh invalidation, disabled apply, trusted keyboard paging, and 360–1440px layouts without overflow or renderer errors.
- Native observations and inspected captures are in [phase-0/conflict-policy-desktop](phase-0/conflict-policy-desktop/verification.json). These are synthetic source combinations based on the pinned Resolve capture; they do not claim an editor write test.
