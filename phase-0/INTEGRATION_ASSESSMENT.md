# Resolve integration assessment

Evidence reviewed through 2026-11-11. Initial target: DaVinci Resolve Free 21.1.2, build 21.1.20010, on macOS. This is a feasibility assessment, not a release support declaration.

## 1. First-user hypothesis

The first useful cohort is a pair of Resolve editors exchanging cuts of one short-form timeline on the same operating system. A narrow initial format would be a single picture track with frame-aligned clips, no nested timelines, and media already accessible to both editors. This cohort and its most-used Resolve version are **hypotheses**. The repository has no interviews, usage data, or consented production projects, so the user/version selection gate remains open. Before choosing the release target, obtain a few representative projects and ask editors which Resolve edition/version and timeline constructs they use daily.

## 2. Free integration boundary

The disposable import → FCPXML export → modified-copy reimport in [the Resolve proof](resolve-xml-proof/README.md) ran in the installed Free 21.1.2 build. The same Free build's internal console exposed item IDs and accepted the tested rename, move, trim, and delete operations on duplicated timelines. This is live evidence for **Free, local UI/internal console, this build only**.

The installed developer `Developer/Scripting/README.md` distinguishes internal scripting from external scripting. The current Electron app uses exported FCPXML, while Free can also be probed through its internal console. External live API control from the Electron app has not been proven in Free. Studio and other Resolve versions are outside the initial target.

On November 17, 2026, a read-only external Python `scriptapp("Resolve")` probe returned no connection while Free 21.1.2/build 21.1.20010 was open on a disposable performance project. The result was the same inside and outside the workspace sandbox. `probe-external-resolve.py` reproduces the check and `external-api-observation.json` records the outside-sandbox result. This does not prove all Free configurations are unable to connect. For this installation, an Electron-controlled live API path remains unavailable; any safe apply design must prove an internal-script bridge or revisit the first editor/edition target.

## 3. Integration paths and test assets

| Path | Read/identity | Write | Licensing and current evidence |
|---|---|---|---|
| FCPXML import/export | Scanner reads top-level picture `<asset-clip>`, `<video>`, and single-picture-source `<clip>` wrappers; FCPXML omits Resolve item IDs. | A copied export with one duration edit reimported. | Proven in Free 21.1.2 on a synthetic still-image project. A thousand-clip Free export scans all 1,001 primary picture clips. FCPXML resource refs changed after reorder, so they cannot supply stable identity alone. |
| Resolve scripting API | `Project`, `Timeline`, and `TimelineItem` expose unique IDs; the API enumerates tracks and items. | `SetPosition`, `SetRightOffset`, and `DeleteClips` are documented and were exercised on duplicate timelines. | Free internal console worked. Studio external scripting is documented; an Electron bridge and full safety transaction are unproven. |
| Native `.drp`/project format | No documented stable on-disk edit schema was found in the installed scripting reference. | A `.drp` import copy was unusable for the planned relink test. | Keep this path out of scope until a documented write surface and a valid copy/reopen proof exist. |

Untouched synthetic and Resolve-exported fixtures live in [the proof](resolve-xml-proof/README.md) and [the compatibility corpus](compatibility-corpus/README.md). The live Free structure fixture covers moving footage, linked audio, extra tracks, a transition, an OFX effect, and a compound clip; the scanner still omits most of those constructs. No release-supported minimum has been declared.

## 4. Read coverage

The installed `DaVinciResolveScript.pyi` documents `GetTimelineCount`, `GetTimelineByIndex`, `GetTrackCount`, `GetTrackName`, `GetItemListInTrack`, item type, source/timeline frames, `GetLinkedItems`, `GetEffects`, and `GetUniqueId`. The [read-only probe](resolve-xml-proof/resolve_api_identity.py) captures these in snapshot schema 3, with effect counts rather than effect parameters and no media paths. Live Free captures from the named test project checked track/link/effect fields; complete enumeration across representative projects remains open. A separate [candidate matcher](resolve-xml-proof/api_export_mapping.py) compares a snapshot to flat FCPXML timing while always refusing to authorize apply.

## 5. Write coverage and decision

The installed type reference documents `TimelineItem.SetPosition`, `TimelineItem.SetRightOffset`, `Timeline.DeleteClips`, and `Timeline.Export`. The prior live Free test exercised move, trim, and deletion on duplicates and saved/reopened item IDs. This confirms a supported API write path exists for **some** clip edits. It does not establish a safe automatic pull: Resolve's API IDs are absent from FCPXML exports, linked edits and ripple behavior need coverage, and the app lacks a transaction, backup, and reopen validation. Keep write and merge controls disabled until a copied real project passes those gates.

Next experiments in Free 21.1.2: establish a safe identity mapping for repeated media or choose an API-only apply path; verify a complete copied-project backup, apply, reopen, and recovery transaction; expand scanner coverage for added tracks and linked audio before a release support promise.
