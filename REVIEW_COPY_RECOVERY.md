# Crash-safe cleanup of incomplete review copies

This completes the review-copy temporary cleanup roadmap item for the existing byte-verified FCPXML copy workflow. Applying a resolved pull to a copy remains a separate item.

## Ownership before bytes

The main process injects a private ownership journal into copy preparation. It durably records the source/destination identities, expected source hash, process identity, and transaction before creating a private staging directory. A private nonce marker and exact stage device/inode/birth-time identity are synced before bytes are written. Publication intent is synced before the exclusive final-name link; publication and validation have separate durable states.

The journal lives in `userData/review-copy-cleanup`, with private files. Staging directories are private and contained in the explicitly selected copy destination. Only the trusted main process supplies these paths; renderer methods accept bounded page offsets or opaque transaction IDs. Public reports contain counts and coded reasons, without source/destination paths or filenames.

Ordinary permission bits and file timestamps are preserved by the existing copy helper. On macOS, preserving an old mtime can affect birth time, so the journal declares that metadata transition in advance and adopts the new stage identity only after verifying complete bytes. Sources retain their bytes, mode, mtime, ctime, and identity in the process-death tests; reading may naturally update access time.

## Startup recovery

Startup and explicit recheck remove only staged aliases with verified private-marker and filesystem ownership. A missing/changed parent, symlink, replacement, unexpected staging contents, unknown birth-time proof, or link to the source prevents automatic removal. PID reuse is checked against a trusted process-start probe; unavailable probes conservatively retain potentially live work.

Before unlinking staged data, cleanup also verifies that the original source still has its recorded identity and hash. An overwritten, deleted, or replaced source preserves the staging bytes as a recovery copy, even before publication. A verified owned staging file can be revealed explicitly; uncertainty falls back to a verified selected parent.

Normal successful preparation releases its staging alias without adding recovery work or a recovery notice. Recovery counters describe interruption/failure cleanup.

Published copies are preserved after interruption or validation failure, including same-inode user edits and original-byte recovery copies whose source later changed. Validated copies are never removed. The old asynchronous error path no longer unlinks a published pathname merely because its inode matches. Corrupt or uncertain recovery storage blocks new preparation and reports the storage problem without guessing which files can be removed.

Seven real process-death/completion checkpoints test partial staging, prepared state, link-before-record ambiguity, publication, interruption during validation, durable validation, and successful completion. Recovery is idempotent. Unrelated files and ambiguous artifacts stay untouched.

## Desktop recovery

The app reports removed temporary aliases and retained copies. A compact disclosure keeps retained records available without crowding the current workflow. Entries are paged 20 at a time from the main process. **Reveal retained copy** resolves the opaque ID against current verified filesystem ownership; if the file cannot be verified, only a verified selected parent can be revealed. It does not open, alter, import, or delete the copy.

Review retained files manually. A retained published artifact can be verified through the existing **Verify existing copy** workflow for its matching selected export. Recovery notices retain the uncertainty record; they do not silently certify a copy based on an old publication acknowledgment.

## Verification

- `npm run test:copy-recovery` covers real filesystem ownership, seven process-death checkpoints, changed/replaced paths and parents, source hard links, corrupted journals, atomic-write failures, process identity, unknown birth times, pagination, and existing copy/verifier behavior.
- `npm run verify:copy-cleanup` writes the standalone seven-checkpoint observation in [phase-0/copy-cleanup](phase-0/copy-cleanup/verification.json).
- `npm run verify:copy-recovery` kills disposable preparers and then starts two shipped Electron processes. It removes 22 staged aliases while preserving 21 unvalidated published copies, one durably validated copy, the source, and an unrelated file. It checks path-free reports, server paging, distinct accessibility names, reveal authority, repeat startup, and desktop/narrow layout. See [phase-0/copy-recovery-desktop](phase-0/copy-recovery-desktop/verification.json).
