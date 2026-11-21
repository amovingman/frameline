# Personal Resolve identity profile

The stable clip/track identity proof targets the installed DaVinci Resolve Free 21.1.2/build 21.1.20010 on macOS (API `21.1.2.10`). Its read-only profile is `resolve-free-21.1.2.10-video-audio-v1`: normal flat video tracks and mono audio tracks with complete matching API/native observations. It does not declare release support.

The original stable-ID roadmap checkbox is complete for these verified saved/reopened checkpoints. The closure audit verifies three blind cases, 24 independent track bindings, all 52 clip IDs retained through rename/move, two retained track index shifts and fresh same-slot recreation identity.

Clip occurrences use project UUID + timeline UUID + `TimelineItem.GetUniqueId()`. Tracks use the same parent namespace plus the native `Sm2TiTrack.DbId` UUID. A fresh per-kind native vector index establishes a track's current API location; indexes, names and clip membership are never its persistent identity. FCPXML remains read-only and supplies no write target. See the [identity authority decision](../RESOLVE_IDENTITY_AUTHORITY.md).

## Required reads

The [supported entry point](supported-native-track-binding.js) requires a source-verified save/close/reopen checkpoint followed by three identical rich API observations around two untouched native exports. Both exports must have the same identity graph and exact complete project/timeline/track/item correspondence. The independent `GetTrackTypeAndIndex()` and `GetPosition(false)` reads must agree for every populated video/audio occurrence, with captured Free product/version/edition and complete rich context. Populated video and audio witnesses are required. A prior UUID ledger or equality to an old project graph is unnecessary.

The native reader accepts only its bounded known structure; layers, geometry, subtitles, unknown track fields and inconsistent type codes refuse. The supported wrapper additionally requires observed video Type0/SubType0/Flags0 and audio Type1/SubType1/Flags0, flat item kinds, at most 64 tracks per kind and complete independent location reads. Unavailable reads stay unavailable. Low-level diagnostic parsing alone cannot authorize this profile.

```sh
# Recompute retained native proof and its acceptance checks.
node phase-0/native-blind-identity-evidence-audit.js
npm run test:identity

# Read-only inspection of a source-bound saved/reopened proof preparation.
node phase-0/supported-native-track-binding.js checkpoint-preparation.json
```

## Independent native experiment

A new disposable project has fresh project/timeline/sequence/container/track UUIDs, four video tracks, four audio tracks, 50 picture occurrences and two occurrences of one WAV asset. All eight track names match. This project and its IDs were withheld from the old calibration ledger.

Each accepted case freezes its complete current-location prediction before a separately prepared challenge. The native challenge verifies the exact prediction file bytes before setters, assigns a unique nonce name to each current API location, saves/reopens, exports, then restores names and saves/reopens again. Independent ground truth matches native name hashes to those unique API nonce names without consulting vector ordinals. Represented state and native identity/parentage must restore exactly.

The three cases cover the initial fresh layout; a changed layout after an empty-track append/deletion and a clip rename/move; and replacement of a known empty track at the same index and name. The persistence comparison requires all 52 clip UUIDs retained, one renamed/moved occurrence, retained track UUIDs with shifted indexes and fresh creation IDs. The recreation ID must differ from every earlier observed track ID, including retired ones.

The first combined perturbation stopped at its expected-result guard because the move changed native enumeration order. Its source, started barrier and intermediate exports are retained as an interrupted run. A separate read-only diagnosis verified exact expected fields by namespaced IDs. A new source-guarded save/reopen and synchronized capture verified that actual state without replaying mutators. Intermediate API states derived for native-export comparison are expectations, not additional live API captures. The intermediate exports retained the earlier saved identity graph and disagree with the expected live topology; the audit preserves that finding and uses saved/reopened endpoints for persistence proof.

This finding limits the operational contract: raw read/export pairs cannot establish current unsaved empty-track identity. The CLI accepts only verified initializer, continuation or saved-endpoint preparation chains and returns a saved checkpoint binding, with `currentUnsavedStateBindingProven: false`. It does not save or inspect a presently open editor. A later unsaved deletion/recreation can leave API shape and stale exported UUIDs unchanged. Future live track writes require a new verified checkpoint or an actual live native-ID accessor.

## Limits

The vector location rule is empirical and the native serialization format is undocumented. Other builds, editions, track subtypes and complex layouts require new proof. Equal surrounding observations are not atomic and cannot exclude concurrent edits reverted between reads. Identity evidence does not establish concurrency-safe track writes, cross-device identity, FCPXML import/rewrite mapping, media readiness, complete enumeration, opaque field preservation or interrupted-write recovery.

The retained public evidence recomputes raw result and parsed graph facts; host-verified receipts bind private native archives and exact issued commands. Private originals remain in the ignored proof directory. These are local development records, not authenticated vendor attestations. Ordinary Apply remains disabled independently of this identity item.

## Validation

All 1,801 full-suite tests, 166 focused integration checks and 33 identity checks pass without skips. Universal-helper packaging and archive-input verification pass. The full suite's disposable localhost HTTP/HTTPS tests require loopback permission; a restricted attempt returned `listen EPERM`, and the permitted full run passed. Independent review also reparsed all 15 private capture/challenge archives and matched their hashes and identity facts to the retained public evidence. All eight temporary editor menus were removed; private evidence remains retained.
