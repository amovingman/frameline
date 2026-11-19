# Complete Resolve comparison review

This completes five review roadmap items for the supported Resolve observation workflow: semantic normalization, change context and timecode display, filtering/grouping, conservative complex-edit checks, and consequences for every conflict choice. Local file previews, saved observation histories, and service-backed observation reviews share the verified comparison. Complete native-project enumeration, persistent track identity, and general apply retain their separate roadmap gates.

## Equivalent values stay unchanged

Supported snapshot values compare by observed entity IDs and canonical keyed collection ordering. Reordering timelines, tracks, clips, links, effects, or property keys is not an edit. Captured decimal properties compare by exact represented decimal identity, including equivalent exponent and signed-zero spellings, without converting through a rounded binary float. Low-level property/effect comparison, saved-history comparison, and three-way review agree.

Unknown observations, unavailable reads, missing keys, and different represented values remain distinct. Normalization affects comparison only: raw source bytes, content addresses, immutable manifests, canonical preview plans, conflict IDs, and saved audit identities remain intact. Tests pin identities from the prior build and exercise semantic no-op source combinations end to end.

## Context and timecode

Each selected change shows the common base, local source, and incoming source independently: timeline name and origin, observed track type/index/name, clip name, timeline/source frame intervals, and up to two neighboring clip observations. Whole-timeline and track-state changes retain their actual context without inventing clip intervals. Saved-history rows show corresponding before/after context beside the property and values.

Captures do not include frame rate. The default shows exact absolute frame positions, timeline-relative frame offsets, and **SMPTE unavailable**. **Timecode display rate** can be set to 24, 24000/1001, 25, 30, 30000/1001, 50, 60, or 60000/1001 fps. It adds explicitly labeled, user-selected, timeline-relative non-drop timecode. Integer/BigInt arithmetic preserves exact frame counts, including large positions and negative relative offsets. This setting is a display preference, not a captured editor fact; it changes neither source bytes nor comparison or saved decisions. No drop-frame convention is inferred.

## Filtering and grouping

Resolve review filters by timeline, observed track, classification/decision status, change type, and field. Filtering runs across the complete verified diff before paging. A move appears under each represented track it touches. Grouping can use timeline, track, status, or change type, with an ungrouped option. Group headings use verified source names where available.

The queue renders at most 40 change buttons per page. Counts report the displayed range, matching total, and full classified total. Previous/Next controls operate by keyboard and preserve filters. **Next unresolved** clears incompatible filters and opens the page containing the next unresolved conflict. Source changes reset paging and discard stale choices; ordinary choice updates preserve the current filter/page when it still exists. Saved history continues to filter the full verified parent diff before its established display limit.

## Conservative complex-edit checks

Each selected change exposes a source-bound risk assessment. It validates all three source scopes, checks reciprocal links and unchanged neighboring intervals, and records observed transition/unsupported-item context. Ripple behavior, linked-media semantics, transitions, nested sequences, and complete timing interactions are never declared safe from incomplete observations.

The report retains a compact record for every supported classified anchor, shares fixed warning descriptions, and bounds neighbor analysis and serialized output. Reaching a comparison limit marks context incomplete. Unknown risks and the overall blocked gate remain after any conflict choice, saved review, refresh, or recovery. A review decision does not authorize editor mutation.

## Consequences for every choice

Each conflict presents the exact three values and a description beside both choices. Consequences cover clip/timeline additions and deletion/restoration, ordinary properties, media identity, links, effects, indexed tracks, and timing fields. Timing choices describe review intent and preserve warnings about combined intervals, neighbors, and ripple behavior. The existing deletion warning and whole-entity safeguards remain in place.

The main process derives context and risk data from the same exact, verified sources as the review. It includes them in the separate guidance hash; canonical plan/review/audit formats remain unchanged. Restart recovery rebuilds the explanations while preserving saved choices and audit identity. Changed source bytes require refreshed review.

## Verification

- `npm run test:comparison-review`: exact normalization, context for every supported conflict kind, honest frame/timecode conversion, source validation, bounded risk analysis, saved-history context, and legacy guidance/artifact compatibility.
- `npm run verify:comparison-review`: shipped main process, preload, and renderer with a disposable profile and fixture-supplied OS picker results; verifies full-before-page filtering, grouping, paging, context and display-rate behavior, no false decimal row, persistent blocked risks, all-choice consequences, saved-review restart recovery, unchanged source bytes, and disabled apply.
- Native observations and inspected desktop/narrow captures are recorded in [phase-0/comparison-review-desktop](phase-0/comparison-review-desktop/verification.json). The fixtures are synthetic combinations of pinned captures, not evidence of a new editor write.
