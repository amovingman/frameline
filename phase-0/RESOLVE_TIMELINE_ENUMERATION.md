# Resolve outer timeline enumeration

The personal target is the installed DaVinci Resolve Free 21.1.2/build 21.1.20010 on macOS (API `21.1.2.10`). Profile `resolve-free-21.1.2.10-saved-outer-av-transition-catalogue-effects-v1` enumerates the six outer timeline construct families in the roadmap. It combines explicitly selected active-timeline reads with independently read saved native structure.

| Family | Enumeration authority |
|---|---|
| Sequences | Project timeline count and every indexed timeline UUID; saved-native timeline/sequence/container membership |
| Tracks | Every video/audio track, including empty tracks; count, kind, current index and name checked against native structure |
| Clips | Timeline occurrence UUID, type, parent track and explicit media-pool reference; repeated source media never deduplicates occurrences |
| Transitions | Typed transition occurrences and current parent track; native UUID membership and supported API metadata |
| Applied effects | Every Fusion, OFX and audio API effect slot on each owning active timeline, including duplicate catalogue types; category, catalogue ID/name, current index and enabled state |
| Linked audio/video | Explicit occurrence-ID relationships within the timeline, with closed and reciprocal peer sets |

The pinned installed SDK defines `Effect` as a Fusion/OFX/Audio effect applied to a timeline item, and documents `TimelineItem.GetEffects(category)` for those objects. It separately defines `Graph` for nodes, LUTs and grades. This profile covers applied API effect slots. It does not enumerate internal Color/Fusion processing graphs, parameter values or persistent effect-instance IDs, and cannot prove that nondefault processing is absent. Those remain separate coverage/preservation gaps. `completeEditorEnumerationProven` and ordinary Apply remain false.

## Why active-owner traversal is required

The actual two-timeline fixture contains seven applied effects. A passive whole-project read reports six when either timeline is active: the inactive timeline's real Chorus effect becomes a **captured empty** audio-effect list. Getter availability checks alone cannot catch this. Both raw orientations are retained as a counterexample.

The supported path explicitly activates every timeline, reads its complete project tree twice, brackets the owner observation with a native export, and restores the original active timeline. Only the selected timeline's own observation contributes its effect/link/item metadata. Off-owner readings remain diagnostic and never replace owner data. All project structural membership must agree across contexts and with the native inventories; duplicate or missing owner coverage refuses completion. The combined result records each owner's source hash and active-context identity. It is sequential, not an atomic snapshot.

The strict capture preserves unavailable reads instead of converting them to empty arrays. Sparse lists, unknown list keys, duplicate identities, incomplete namespaces, unclosed links, unavailable required owner collections and inconsistent native structures refuse. The native reader keeps effect and link byte arrays opaque; it never infers zero effects or links from those bytes. Native audio subtype codes 0 and 1 are separately observed, without guessing channel-format semantics from their numeric values.

```sh
# Inspect a source-verified complete active-owner capture preparation.
node phase-0/supported-timeline-enumeration.js /absolute/private/preparation.json
npm run test:enumeration
```

The operational entry point requires the actual prepared-source/backup/result chain. Raw captures or caller-supplied “complete” flags cannot bypass traversal and provenance checks. Native structural membership comes from a verified saved/reopened checkpoint; applied effect/link metadata comes from the recorded API read interval. Opaque native payloads do not independently verify saved effect/link semantics or present unsaved native identity.

## Controlled native proof

A fresh project has two timelines, 60 typed occurrences, 12 tracks, two Cross Dissolves, seven effects spanning all three categories, repeated movie occurrences, duplicate-name empty tracks and two linked audio/video pairs. Owner traversal finds Fusion2/OFX3/audio2 and four directed link relationships. Native inspection independently matches all item UUID/type/track memberships and media references. Native transition `Name` differs from the API display name, so no guessed name alias is used for transition joins.

The changed checkpoint has a fresh third timeline and ordinary video/audio occurrences. Its complete three-owner inventory contains 62 items, 18 tracks, nine effects and six directed relationships. Independent comparisons detect a Gaussian-to-Transform substitution at the same OFX slot/count, a replaced transition UUID at the same transition count, and a changed linked pair at the same relationship count on the original timeline. These tests exercise content rather than aggregate counts alone.

The original frame-rate settings attempt stopped before importing any clips. A separate guarded retry omitted that optional call. The first change attempt stopped after effect/transition replacement and unlinking when Resolve rejected a cross-offset relink. Separate read-only owner inspection found exactly those partial changes; a persistence-only contract then saved/reopened that state and produced a host-verified fresh backup. A new continuation linked the aligned second pair and added the third timeline without replaying the earlier setters. Failure exceptions and exact sources remain private; public receipts retain typed stages and hashes. An incomplete result during an active invocation never authorizes replay.

The restoration returns all 58 ordinary occurrence UUIDs, native track/parent membership, seven applied effect slots and four directed links to their original represented state. The main transition is a declared fresh replacement, checked against every earlier case; its original UUID and opaque native bytes are not restored.

The first compound-control program stops because `CreateCompoundClip` returns nil. A separate read-only capture shows that the call nevertheless replaced the negative timeline's clips with fresh compound-named A/V occurrences and a new media-pool object. Their media-pool `GetTimeline()` calls return nil, recorded as `leaf` by the capture. Neither the setter's nil return nor that capture label establishes that no nested content was created. The original diagnostic refuses its expected ordinary-movie projection. A separate source-bound reader admits that exact observed state while preserving the original diagnostic refusal. A persistence-only contract verifies every owner before/after Save/Close/Load/export without repeating content setters. Native inspection finds both API-visible occurrences referencing an explicit `Sm2MpCompoundClip`, its embedded sequence and a fourth native sequence container with the original movie occurrences. The frozen flat native reader refuses the archive. A separate bounded witness reader verifies those references; the supported inventory never drops the hidden content or promotes the API leaf result into completeness. These failures remain distinct from successful contracts; internal graph contents and native preservation are never inferred from outer enumeration.

## Boundaries

Unknown native shapes, layered/geometry tracks, unsupported item kinds and nested references refuse the flat profile. A nil API nested-timeline result alone is insufficient to establish the absence of compound content; native structure is an independent boundary. Native serialization is undocumented. Zero-origin timing is cross-checked on the fixture; other timing origins remain uncalibrated metadata, and placement/retime semantics are not established by this enumeration gate.

The inactive-audio finding also limits historical passive multi-timeline effect guards. The existing single-timeline drills do not supply evidence for complete multi-timeline coverage. This research does not enable ordinary Apply, establish opaque field equivalence, authorize FCPXML writes or declare a public release range.

Final validation passed: 1,859 full-suite tests and 58 focused enumeration checks, with no skips; universal-helper packaging and archive checks also passed. Independent reviewers reparsed all seven flat capture archives and the compound archive against the published facts. The public audit verifies 83 compressed artifacts and 32 source pins. Private retention preserves fourteen phases; all fourteen exact owned menu scripts were removed.
