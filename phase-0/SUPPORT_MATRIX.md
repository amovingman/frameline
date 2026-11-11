# Experimental compatibility boundary

This is a test boundary, not a release support promise. The only editor build used for a live round-trip proof is **DaVinci Resolve Free 21.1.2 (build 21.1.20010) on macOS**. Studio, other operating systems, and other Resolve versions have not passed this repository's end-to-end proof. No minimum release-supported editor version is declared.

The desktop scanner now accepts **FCPXML 1.10** only. The selected `.fcpxml` file or `.fcpxmld/Info.fcpxml` is read only, up to 20 MB. A different or missing FCPXML version produces a recovery error. This version gate reflects the fixtures and Resolve exports on hand; it does not assert that every FCPXML 1.10 construct is handled.

| Construct | Current read-only behavior |
|---|---|
| First sequence's top-level picture `<asset-clip>` and Resolve `<video>` | Scans order by frame offset, duration, source-in, enabled state, and media display name. IDs remain unresolved. |
| Additional sequences and video tracks | Not represented; warns for additional projects. Connected lanes are skipped with a warning, including lanes attached inside a gap in the live Resolve fixture. |
| Transitions, nested sequences, titles, generators, multicam, compound/sync clips | Not represented; unknown spine element is named in a warning. |
| Audio attached inside a picture clip and effects/adjustments | Picture clip is counted, but nested content is not represented; warns. |
| Media references | `file:` existence is checked without loading contents; external, absent, and inaccessible sources stay unresolved. Media paths remain in the main process. |
| Round-trip editing | No app write or pull path. The disposable FCPXML copy edit and Resolve reimport prove only one isolated still-image duration change. |

The compatibility corpus includes synthetic edit pairs, a narrow Resolve-backed still-image proof, and a Free 21.1.2 moving-media structure fixture with linked audio, multiple tracks, a transition, an OFX effect, and a compound clip. The live export shows that the scanner sees only the primary picture clip and warns about omitted nested and gap-attached content. To declare a release minimum, validate intended-user projects and Studio behavior on copies created by each proposed supported version.
