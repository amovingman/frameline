# Resolve identity authority for the personal experiment

The experimental write path uses Resolve's live API IDs to locate objects. FCPXML remains a read-only sequence/media diagnostic and is not a source of clip or track write targets. This follows the existing guarded rename path and does not enable ordinary Apply.

The target is the installed Resolve Free 21.1.2/build 21.1.20010 on macOS. No other version, edition or device is covered by this decision.

| Object | Identity | Current location and validation |
|---|---|---|
| Project | API `Project.GetUniqueId()` | Exact current project UUID, expected name and installed version must match. A name alone cannot select the project. |
| Timeline | Project UUID plus API `Timeline.GetUniqueId()` | Enumerate current timelines and require one exact UUID match. Timeline indexes and names are locations or labels. |
| Clip occurrence | Project UUID, timeline UUID and API `TimelineItem.GetUniqueId()` | Enumerate current items and require exactly one matching occurrence in the expected timeline and full observed source. Media-pool IDs identify source assets, not timeline occurrences. |
| Track | Project/timeline namespace plus observed native `Sm2TiTrack.DbId` | A fresh native/API binding must establish the current API location. The native vector position is a serialization location, not the persistent identity. Empty tracks cannot be identified from clip membership. |

The retained API experiments distinguish repeated-media occurrences and retain occurrence UUIDs through rename, move, trim and save/reopen. The native track experiments distinguish retained, deleted and recreated UUIDs through name changes and index shifts. A synchronized read-only binding is a separate proof requirement; temporary name challenges do not become an ordinary capture mechanism.

Any calibrated native location rule must declare its exact build and tested layouts, validate complete project/timeline/track/item counts and explicit native item parentage, and reject unsupported or inconsistent structures. It must retain the untouched export hash and matching API captures around export. Equal captures describe represented stability over that interval; they do not make the interval atomic or prove opaque native preservation.

An ambiguous or absent binding remains unavailable. The integration must not fall back to a track name, clip name, media path, timeline position, FCPXML candidate match or guessed ordinal. Native archives are read, never patched.

This decision removes an unnecessary dependency between direct API rename experiments and FCPXML occurrence mapping. It does not establish reliable identity for a separate XML import/rewrite path. Such a path would need its own occurrence mapping, import identity and preservation proof before it could write anything.

Complete enumeration and field preservation remain independent blockers. A successful locator does not authorize a mutation, establish cross-device identity or prove recovery from interrupted editor writes. Every experimental mutation still needs exact reviewed source/result guards, a verified native backup, a replay barrier and separately inspected recovery.
