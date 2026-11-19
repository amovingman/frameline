# Studio storage: local verification and relink proposals

History → **Studio storage** provides the next twenty deliverable features after team templates. This is an explicit local, read-only workflow for a selected folder and a studio-supplied asset request. It works independently of service sign-in and editor selection. It does not establish editor identity, source freshness, or a release-supported NAS integration.

## Delivered feature checklist

1. [x] Register a storage folder using a native directory picker.
2. [x] Save up to 32 registrations in a private, versioned local registry.
3. [x] Give registrations safe display labels and rename them.
4. [x] Forget a reviewed registration and its reports without deleting media.
5. [x] Explicitly check online, offline, unreadable, and changed-folder states.
6. [x] Locate a moved folder only when its observed device/inode identity matches; invalidate old checks after reconnection.
7. [x] Import a studio asset request using a native file picker.
8. [x] Validate a bounded request schema, identity values, unique asset IDs, and unique relative locations.
9. [x] Bind each request and result to the supplied project ID and source hash.
10. [x] Resolve only explicit root-relative locations; reject traversal and absolute paths.
11. [x] Refuse symbolic links in the root, directory ancestry, and media paths.
12. [x] Stream media through SHA-256 and compare exact byte sizes and content hashes.
13. [x] Distinguish missing, unreadable, wrong-size, wrong-content, non-file, and changed-during-read results.
14. [x] Preserve each requested media class through reports and proposals; never search for proxy substitutes.
15. [x] Show asset/byte progress and allow cancellation without saving partial results.
16. [x] Serialize registry changes with atomic replacement, private modes, file/directory flushes, and uncertain-write refusal.
17. [x] Recover the last completed report after restart as historical evidence, with its original check time.
18. [x] Retain an interrupted-check marker and require an explicit fresh request/check after restart.
19. [x] Filter verified/failed results and page large reports in increments of 100 rows, with keyboard-accessible controls and literal text rendering.
20. [x] Review a source-bound relink proposal after fresh verification, then export only the exact reviewed artifact through a native save dialog after another byte check.

## Use

Enter a storage label and choose a folder. Import an asset request, review its requested project/source hash, and choose **Verify requested media**. Failed rows explain what could not be verified. A fully verified check enables **Review relink proposal**; review the proposal hash before saving it. Saving creates a new file and refuses an existing filename.

The source hash is supplied by the request author. Frameline does not compare it to the selected editor project or claim that the author is authenticated. A report describes this local check only. Each request explicitly specifies its media class; matching bytes do not prove that the declared class is correct. No filename search, file copy, upload, download, editor mutation, or service-base update occurs.

## Request format

Supply UTF-8 JSON, at most 1 MiB and 1,000 assets. All fields shown are required; unknown fields are rejected. Hashes are lowercase hexadecimal SHA-256. Relative locations use `/` separators and must stay under the selected folder. Duplicate IDs and locations are rejected. Request order does not change the normalized request hash.

```json
{
  "schemaVersion": 1,
  "projectId": "film-001",
  "sourceHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "assets": [
    {
      "id": "shot-001",
      "relativePath": "Picture/shot-001.mov",
      "assetClass": "original",
      "expected": {
        "size": 20,
        "sha256": "355daa294300e8ae732b163ba3334be1bb9b95277da9112ded50b9f137ee489c"
      }
    }
  ]
}
```

This example uses an illustrative source hash and the asset bytes `verified camera data` (20 bytes, no trailing newline). Generate identities from your intended media bytes. Supported classes are `original`, `proxy`, `audio`, `graphics`, and `other`. Empty regular files are valid when size and hash match. Directories, symlinks, special files, and filename-only candidates cannot verify.

## Privacy, recovery, and limits

`userData/shared-storage/storage.json` stores folder paths and observed device/inode identities privately (directory `0700`, files `0600`). The renderer and exported proposals receive no locations or native inode/device values. Completed reports contain IDs, classes, expected identities, results, and binding hashes. File and folder labels should not contain sensitive information. No root marker is written on a shared volume.

The registry uses a cooperative local lock. Missing initialized state, invalid reports, unsafe modes, symlinked state, and newer schemas fail closed. An uncertain atomic publication stops that store instance until restart. Startup does not probe registered roots or resume hashing; the user explicitly selects a folder and checks again. An interrupted first registry initialization also fails closed and requires local investigation. Keep the private registry with local backups; do not manually delete initialized records to repair it.

Device/inode equality is a conservative local observation, not a portable volume UUID or proof of a remote mount's authenticity. A remount may require a new registration. SMB/NFS semantics, permissions changes on real studio mounts, hostile filesystem races, physical disconnects, process-kill/power-loss durability, and physical cross-device workflows need separate evidence. Streaming rechecks the root and file metadata before/after reading; it does not provide kernel-enforced `openat` containment against a concurrently malicious filesystem.

Cancellation is cooperative between filesystem reads. A stalled operating-system or remote filesystem call may delay it. Verification records sequential observations rather than a point-in-time snapshot of all assets.

Proposals are deliberately `readOnly: true` and `executable: false`. They omit relative locations and cannot be applied or used as editor relink commands. Actual project relinking, canonical revision-to-media bindings, native editor validation, and release support remain open roadmap work.

## Validation

`npm run test:storage` covers contracts, containment, hash and size mismatches, mutation during streaming, root replacement, cancellation, restart, historical reports, interrupted markers, stale choices, private registry corruption, concurrent writers, uncertain saves, renderer filtering/paging, and confirmation scope.

`node_modules/.bin/electron scripts/verify-shared-storage-desktop.cjs` exercises the real packaged preload API with the real controller and disposable filesystem media. Native picker return values are supplied by the harness. It verifies the positive workflow, exact exported artifact, unchanged media, report recovery after controller restart/page reload, changed-byte refusal, and forget cancellation. It checks layout widths of 360, 390, 768, and 1440 pixels. This is not a full native application or operating-system restart. See [verification evidence](phase-0/shared-storage-desktop/verification.json) and the adjacent screenshots.

The completed batch passed all 1,299 full-suite tests without skips (including 29 new storage tests), packaging validation, and changed-UI source lint. Visual checks retained the existing graphite/Plex design. The design detector reported only existing advisory palette findings outside this new section.
