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
