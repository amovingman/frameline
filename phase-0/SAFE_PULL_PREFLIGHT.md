# Safe-pull preflight foundations

These are ten local safety slices for the Free 21.1.2 experiment. They do not make a pull executable.

1. Stream media files through SHA-256 without loading them into memory.
2. Report local, missing, and unknown media; offline-volume, proxy-only, and excluded require explicit evidence.
3. Search a user-selected folder with limits and without following observed symlinks.
4. Verify candidate media by file size and SHA-256, not name alone.
5. Produce a path-free readiness report that requires verified originals for required media.
6. Reserve a noncolliding `.fcpxml` review-copy filename in a selected directory.
7. Make a byte-verified review copy while preserving ordinary mode and timestamps.
8. Confirm the source hash and file identity again before publishing the copy.
9. Remove incomplete temporary copies after a failed preparation.
10. Run a read-only apply preflight that reports missing plan, audit, media, source, restore-point, or adapter gates.

For local experiments, `check-media-readiness.js` reads an array of media entries containing opaque `id`, local `path`, and expected `{size, sha256}`. The report omits all paths. `prepare-review-copy.js` requires the current source hash and creates a byte-identical copy; it does not apply a plan:

```sh
node phase-0/check-media-readiness.js media-input.json
node phase-0/prepare-review-copy.js source.fcpxml copies Review.fcpxml EXPECTED_SHA256
```

The review-copy helper accepts regular `.fcpxml` files up to the scanner's 20 MB limit; bundles and symlink path components are refused. `checkApplyPreflight` is a main-process diagnostic only. The current Resolve API snapshots cannot authenticate a project file, media requirements are not bound to verified file paths, and the FCPXML adapter lacks safe apply and editor validation. It therefore always returns `safeToApply: false`. No project file is modified by these preflights.

## Native Resolve export and import probe (2026-11-17)

On the disposable `Frameline Lua Capture Fixture` in Resolve Free 21.1.2, `ProjectManager.ExportProject(projectName, filePath, false)` returned `true` and created a 66,084-byte `.drp`. Its SHA-256 is `d2d32919cf785eec4c7ecddf76d8741039f1ad54b63477f5fb69024ccc30af04`. ZIP integrity checks passed for `project.xml`, `MediaPool/Master/MpFolder.xml`, one `SeqContainer` XML member, and `Gallery.xml`. Resolve initially created the export with mode `0666`; the probe set it to `0600` before further inspection. Any backup service must create exports in a private directory and verify restrictive permissions before treating them as restore points.

`ProjectManager.ImportProject` was then invoked with the exported path and a distinct name, `Frameline Restore Probe`. Resolve created a separate local project at that name. Its `Project.db` passes SQLite `PRAGMA integrity_check`. The original project remains present. Opening the imported copy in Resolve showed `Frameline Capture Timeline` at `00:00:51:00`, with three clips on Video 1 and 49 clips on Audio 1, matching the track counts of the saved source capture. Media-pool thumbnails and the linked final video/audio clip were visible. Effect settings, every item property, and a post-import API snapshot were not compared; an apply/rollback transaction remains unproven.

`inspectResolveProjectExport` is a read-only verifier for private `.drp` files. It fingerprints the file before and after ZIP member and CRC checks, requires a project XML, media-pool XML, and at least one sequence XML, and rejects group/world-readable exports, symlinks, and changed files. Its result is evidence about an archive, not permission to write to an editor project.

## Compare captured recovery content

After capturing the source and reopened copy through the companion, run:

```sh
node phase-0/compare-resolve-recovery.js source-snapshot.json recovered-snapshot.json
```

The command binds its report to both exact input hashes and compares all schema-3 observed fields using the existing ID-based differ. It allows a distinct project ID/name for an imported copy, but requires original timeline/item IDs to match; regenerated IDs produce additions/deletions rather than guessed matches. Enumeration order is ignored. Track names, item names, timing, source bounds, media-pool IDs, links, and effect counts are compared. Exit status is `0` for matching observed fields, `2` for differences, and `1` for invalid inputs. Input paths are omitted from the report and error messages.

The result always retains `recoveryValidated: false`: snapshot provenance, effect identity/settings, nested content, media bytes, and other uncaptured properties remain unverified. Automated tests use the pinned mixed live source capture and deliberately changed copies. A fresh companion capture of the reopened `Frameline Restore Probe` has not yet completed, so no live source/copy comparison result is claimed.
