# Personal operation compatibility boundary

The personal integration target is **DaVinci Resolve Free 21.1.2 (build 21.1.20010) on macOS**. The currently observed owner host is **macOS 15.6.1/build 24G90 arm64**; earlier proofs recorded macOS without its patch/build. Other editions, hosts and Resolve versions are outside this declaration. No public release support range or minimum release-supported editor version is declared.

The [personal operation matrix and saved-project corpus](../PERSONAL_COMPATIBILITY.md) now distinguish the later guarded native Name workflows, historical result audits and a new derived proxy-review import from the scanner. `src/personal-compatibility.js` provides read-only profile recognition without execution authority. `src/compatibility-contract.js` retains its older exact version/build/platform/FCPXML 1.10 scanner contract and grants no write or release authority. A recognized profile never replaces the operation's independent safety guards.

Compatibility is declared per editor edition, build, operating system, format version, timeline construct, and operation. This matrix does not imply support for every Resolve project file or for other editing applications. A second editor requires its own corpus and release row under `EDITOR_EXPANSION.md`.

The desktop scanner now accepts **FCPXML 1.10** only. The selected `.fcpxml` file or `.fcpxmld/Info.fcpxml` is read only, up to 20 MB. A different or missing FCPXML version produces a recovery error. This version gate reflects the fixtures and Resolve exports on hand; it does not assert that every FCPXML 1.10 construct is handled.

| Construct | Current read-only behavior |
|---|---|
| First sequence's top-level picture `<asset-clip>`, `<video>`, and Resolve `<clip>` with exactly one asset-backed `<video>` child | Scans order by frame offset, duration, source-in, enabled state, and media display name. Wrapper timing is used for `<clip>`. IDs remain unresolved. |
| Additional sequences and video tracks | Not represented; warns for additional projects. Connected lanes are skipped with a warning, including lanes attached inside a gap in the live Resolve fixture. |
| Transitions, nested sequences, titles, generators, multicam, compound/sync clips | Not represented; unknown spine element is named in a warning. |
| Audio attached inside a picture clip and effects/adjustments | Picture clip is counted, but nested content is not represented; warns. |
| Media references | `file:` existence is checked without loading contents; external, absent, and inaccessible sources stay unresolved. Media paths remain in the main process. |
| Round-trip editing | The scanner remains read-only. A separate reviewed-copy operation can patch explicit original/proxy references and create a new derived review project; its exact paths/frames and save/reopen/closed hash are verified. General FCPXML round-trip preservation remains unproven. Guarded native Name Apply/pull uses its own complete stored-value proof and does not promote XML occurrence IDs. |

The compatibility corpus includes synthetic edit pairs, a narrow Resolve-backed still-image proof, and a Free 21.1.2 moving-media structure fixture with linked audio, multiple tracks, a transition, an OFX effect, and a compound clip. The scanner sees the primary picture clip in that fixture and warns about omitted nested and gap-attached content. On the separate Free 21.1.2 thousand-clip export, it enumerates all 1,001 primary picture clips, while still warning about omitted audio, effects, and added tracks. The new personal catalog also authenticates two retained saved native databases and rereads their complete production censuses. Exports remain explicitly distinct from native saved projects. Neither corpus implies complete project coverage, a general Apply rule or a public release range; broader public-release validation remains deferred.

A separate [read-only diagnostic](READ_ONLY_INVENTORY.md) now inventories serialized sequences, lane/gap hierarchy, explicit audio, transitions, and filters/adjustments in the named Free test export. Its result is not part of the app scan manifest or a write path. FCPXML lane coordinates, linked identity, and effects missing from the XML remain unresolved.

The November19 editor-choice decision retains its [original support-matrix bytes](evidence-sources/support-matrix-observed-20261119.md.txt). Its historical reassessment checks that archive against the original fixed hash and preserves the original decision JSON and decision hash. That evidence describes the capabilities known at the time; the current personal operation matrix above documents later, separately proven workflows.
