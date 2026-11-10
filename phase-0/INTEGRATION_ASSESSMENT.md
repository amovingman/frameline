# Resolve integration assessment

Evidence reviewed on 2026-11-09. Candidate: DaVinci Resolve 21.1.2, build 21.1.20010, on macOS. This is a feasibility assessment, not a support declaration.

## 1. First-user hypothesis

The first useful cohort is a pair of Resolve editors exchanging cuts of one short-form timeline on the same operating system. A narrow initial format would be a single picture track with frame-aligned clips, no nested timelines, and media already accessible to both editors. This cohort and its most-used Resolve version are **hypotheses**. The repository has no interviews, usage data, or consented production projects, so the user/version selection gate remains open. Before choosing the release target, obtain a few representative projects and ask editors which Resolve edition/version and timeline constructs they use daily.

## 2. Free and Studio availability

The disposable import → FCPXML export → modified-copy reimport in [the Resolve proof](resolve-xml-proof/README.md) ran in the installed Free 21.1.2 build. The same Free build's internal console exposed item IDs and accepted the tested rename, move, trim, and delete operations on duplicated timelines. This is live evidence for **Free, local UI/internal console, this build only**.

The installed developer `Developer/Scripting/README.md` distinguishes internal scripting from Studio's external scripting preference and says the API has a common superset whose Studio-only calls can fail in Free. Blackmagic's [Studio product page](https://www.blackmagicdesign.com/products/davinciresolve/studio) lists scripting and workflow integration for Studio. Neither source establishes that every API call behaves the same across editions. A separate Studio import/export and API test is still required; the edition gate remains open. For the Electron app, external live API control appears to require Studio, while Free can be probed from the internal console.

## 3. Integration paths and test assets

| Path | Read/identity | Write | Licensing and current evidence |
|---|---|---|---|
| FCPXML import/export | Current scanner reads only top-level picture clips; FCPXML omits Resolve item IDs. | A copied export with one duration edit reimported. | Proven in Free 21.1.2 on a synthetic still-image project. FCPXML resource refs changed after reorder, so it cannot supply stable identity alone. |
| Resolve scripting API | `Project`, `Timeline`, and `TimelineItem` expose unique IDs; the API enumerates tracks and items. | `SetPosition`, `SetRightOffset`, and `DeleteClips` are documented and were exercised on duplicate timelines. | Free internal console worked. Studio external scripting is documented; an Electron bridge and full safety transaction are unproven. |
| Native `.drp`/project format | No documented stable on-disk edit schema was found in the installed scripting reference. | A `.drp` import copy was unusable for the planned relink test. | Keep this path out of scope until a documented write surface and a valid copy/reopen proof exist. |

Untouched synthetic and Resolve-exported fixtures live in [the proof](resolve-xml-proof/README.md) and [the compatibility corpus](compatibility-corpus/README.md). Moving footage, multitrack audio, transitions, effects, nested sequences, and cross-version exports are still missing from live compatibility coverage. No minimum supported version or version range has been declared.

## 4. Read coverage

The installed `DaVinciResolveScript.pyi` documents `GetTimelineCount`, `GetTimelineByIndex`, `GetTrackCount`, `GetTrackName`, `GetItemListInTrack`, item type, source/timeline frames, `GetLinkedItems`, `GetEffects`, and `GetUniqueId`. The [read-only probe](resolve-xml-proof/resolve_api_identity.py) now captures these in snapshot schema 3, with effect counts rather than effect parameters and no media paths. Its synthetic contract tests pass. The new track/link/effect fields still need a live Free and Studio capture before claiming complete enumeration. In particular, transition and nested-sequence representation must be checked on representative projects. A separate [candidate matcher](resolve-xml-proof/api_export_mapping.py) compares a snapshot to flat FCPXML timing while always refusing to authorize apply.

## 5. Write coverage and decision

The installed type reference documents `TimelineItem.SetPosition`, `TimelineItem.SetRightOffset`, `Timeline.DeleteClips`, and `Timeline.Export`. The prior live Free test exercised move, trim, and deletion on duplicates and saved/reopened item IDs. This confirms a supported API write path exists for **some** clip edits. It does not establish a safe automatic pull: Resolve's API IDs are absent from FCPXML exports, linked edits and ripple behavior need coverage, and the app lacks a transaction, backup, and reopen validation. Keep write and merge controls disabled until a copied real project passes those gates.

Next experiments: capture schema-3 snapshots from the same disposable project before and after edits; prove an exact API-item ↔ export-clip mapping or use API-only apply; test relink on a valid copied project; run the same matrix on Studio and on the eventual supported version range.
