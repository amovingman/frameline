# Restarting interrupted local work

The owner workflow retains interrupted timeline scans, explicitly confirmed media transfers, and the supported native Name Apply. Startup reads private recovery metadata. It does not reopen a remembered timeline export, read selected source media, upload chunks, replay publication, admit an editor command, or claim validation complete.

## Timeline scans

Each FCPXML scan commits a private authenticated intention before entering the worker. It retains the selected local project and branch, private source/bundle identity, attempt, bounded phase/progress, and terminal source/manifest hashes. A stopped host or worker leaves an interrupted attempt. A cancelled scan remains cancelled. Failed and completed attempts remain historical receipts; they are not partial manifests.

Open **Interrupted work**, choose **Reselect export and restart**, and select the same export with the native picker. A restart must match the retained source selection, local project and branch. It starts a complete fresh worker read, hash, parse and media-reference check. Changed reselected bytes are explicitly recorded as a fresh changed-source attempt. No parsed inventory, partial hash or media result is reused across interruption. Choosing **Cancel retained scan** retires the intention without reading the source, so a moved or missing export can be cancelled safely. Another live owner process cannot restart or cancel its running operation.

A source that was scanned successfully remains subject to the existing fresh-source checks before revision saving or comparison. Recovery metadata does not create a revision, restore point, sync base, native project identity claim, or editor write.

## Media uploads and downloads

The existing media-transfer journal binds every confirmed job to the service origin, account, local project/branch and remote project/branch. Restart restores account credentials through the configured vault, but transfer rows require the matching project/binding selection. No transfer begins until an explicit Resume. Permissions, current class policy and archive state are checked again.

Upload Resume rereads and hashes the source against its reviewed content identity, obtains the server's durable acknowledged-chunk bitmap, sends only missing chunks, and requires service-side complete-content verification. A source replacement or change fails before it can substitute for the reviewed asset. A lost completion acknowledgment can be retried for the same content identity without inventing another asset.

Download Resume validates retained checkpoint geometry and cached chunk hashes. An identical already-published destination can be verified and reused. An existing different destination is preserved. A dead work-directory lease can be reclaimed with bounded exclusive acquisition; another live owner is refused. Cancellation stops local work and requests verification cancellation where supported. It does not undo publication that already completed.

## Owned staging

Journal replacement, cached chunks/checkpoints and final download assembly now reserve each exact random temporary path in a flushed private per-operation manifest before file creation. The exclusive file descriptor's device/inode and owner/mode are retained before any payload is written. Canonical targets remain separate from the temporary artifact.

**Inspect retained staging** is explicit. A complete temporary is discardable only when the recorded path, inode, private metadata, exact size and full content hash agree and its prior owner is no longer active. A final published download may retain a second hard link after a crash; discarding that exact owned temporary preserves the destination's inode and bytes. The cleanup API never removes or replaces the canonical journal, source or destination.

Partial, unbound, replaced, divergent and unverified files are retained. They are not guessed from a filename or deleted automatically. Recognized first-initialization staging does not prevent a fresh empty transfer journal or checkpoint from being created, while an absent previously initialized journal still fails closed. Staging inspection is scoped to the current account/project context, and a stale scope cannot discard a previously displayed artifact.

## Native Apply

The supported operation remains one existing video clip Name in an owner-controlled closed local Resolve project. See [native pull planning](NATIVE_PULL.md) and [Safe Apply](SAFE_APPLY.md).

The intention and core transaction are authenticated before effects. A death after atomic publication but before its completion receipt leaves a raw publication phase. Explicit recovery compares the current file with the retained original and candidate. It does not publish again. Candidate/original recovery can prepare a fresh direction-bound editor check; reading that check while the editor is open remains separate from closed-file recovery. Success still requires native readback and final post-close exact bytes, metadata and preservation validation. Restoration requires its own independent direction and validation.

Cancelled or safely retired intentions remain terminal. They cannot be resurrected by recovery or used for Apply, rollback, validation or native admission after a later project happens to match an older candidate. An active newer intention also blocks an older completed transaction's effect actions.

## Verification

Run the focused checks with:

```sh
node --test tests/desktop-scan-recovery.test.js tests/owned-transfer-staging.test.js tests/transfer-crash-recovery.test.js tests/asset-file-transfer.test.js tests/desktop-asset-transfers.test.js tests/native-pull-session.test.js tests/native-pull-execution.test.js
node scripts/verify-integrated-crash-recovery.cjs
```

[Integrated desktop evidence](phase-0/integrated-crash-recovery/verification.json) uses five real Electron processes with shipped main/preload/renderers, the production worker scanner, an actual certificate-verified loopback HTTPS service and production chunk/file engines. Three `SIGKILL` deaths bypass orderly shutdown: during a scan, after the first acknowledged upload chunk, and after real atomic SQLite publication before its core receipt. The restarted upload sends only the remaining chunks; the native transaction reconciles without replay and restores its exact pre-Apply bytes. Another restart preserves completed receipts. Desktop and narrow layouts have no horizontal overflow or renderer errors.

The integrated native hardware/readback and account/picker/vault/TLS inputs are explicitly disposable fixtures. Independent live Resolve admission and preservation are recorded in the native Apply/pull evidence. These checks cover host-process death, not machine power loss, arbitrary external concurrent writers, unsupported editor operations, hosted automatic Apply, or automatic cleanup of unverified staging.
