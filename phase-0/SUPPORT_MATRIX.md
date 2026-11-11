# Experimental compatibility boundary

The initial integration target is **DaVinci Resolve Free 21.1.2 (build 21.1.20010) on macOS**. This is a test boundary, not a release support promise. Other editions, operating systems, and Resolve versions are outside the current target. No minimum release-supported editor version is declared.

The desktop scanner now accepts **FCPXML 1.10** only. The selected `.fcpxml` file or `.fcpxmld/Info.fcpxml` is read only, up to 20 MB. A different or missing FCPXML version produces a recovery error. This version gate reflects the fixtures and Resolve exports on hand; it does not assert that every FCPXML 1.10 construct is handled.

| Construct | Current read-only behavior |
|---|---|
| First sequence's top-level picture `<asset-clip>`, `<video>`, and Resolve `<clip>` with exactly one asset-backed `<video>` child | Scans order by frame offset, duration, source-in, enabled state, and media display name. Wrapper timing is used for `<clip>`. IDs remain unresolved. |
| Additional sequences and video tracks | Not represented; warns for additional projects. Connected lanes are skipped with a warning, including lanes attached inside a gap in the live Resolve fixture. |
| Transitions, nested sequences, titles, generators, multicam, compound/sync clips | Not represented; unknown spine element is named in a warning. |
| Audio attached inside a picture clip and effects/adjustments | Picture clip is counted, but nested content is not represented; warns. |
| Media references | `file:` existence is checked without loading contents; external, absent, and inaccessible sources stay unresolved. Media paths remain in the main process. |
| Round-trip editing | No app write or pull path. The disposable FCPXML copy edit and Resolve reimport prove only one isolated still-image duration change. |

The compatibility corpus includes synthetic edit pairs, a narrow Resolve-backed still-image proof, and a Free 21.1.2 moving-media structure fixture with linked audio, multiple tracks, a transition, an OFX effect, and a compound clip. The scanner sees the primary picture clip in that fixture and warns about omitted nested and gap-attached content. On the separate Free 21.1.2 thousand-clip export, it now enumerates all 1,001 primary picture clips, while still warning about omitted audio, effects, and added tracks. This does not establish complete project coverage or safe apply. Before a release promise, validate intended-user projects in the selected Free build.

A separate [read-only diagnostic](READ_ONLY_INVENTORY.md) now inventories serialized sequences, lane/gap hierarchy, explicit audio, transitions, and filters/adjustments in the named Free test export. Its result is not part of the app scan manifest or a write path. FCPXML lane coordinates, linked identity, and effects missing from the XML remain unresolved.
