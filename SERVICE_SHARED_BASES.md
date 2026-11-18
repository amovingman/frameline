# Service-scoped shared bases

History now records the last verified common revision between a selected local branch and its linked service branch. This is a historical observation for one service/account/project/branch mapping. It does not establish that current editor edits, the selected source, or media are synchronized.

## Desktop behavior

**Check history**, successful **Push revisions** or queue **Retry**, and **Fetch history** verify captured remote ancestry against saved local records. A matching root-to-revision prefix can produce a shared-base receipt. Equal heads record that head; local-ahead or remote-ahead histories can retain a matching ancestor. Histories without an exact common prefix produce no new base. Viewers can check and fetch, with the original publisher retained as the remote author.

The service panel shows the recorded local/remote revision IDs and check time. Local History rows and open revision details use **Last shared base** for the matching local revision and **After shared base** for its descendants; other rows remain **Local revision**. These labels follow the current linked scope and clear on sign-out or a different binding. Branch comparison separately describes the heads observed at the last check.

Check and Push may read complete remote metadata to establish proof, but their proof snapshots do not create or advance the fetched-history display. Only explicit Fetch updates that display's index. Fetch remains read-only: it does not import remote revisions, move a local branch, pull edits, or apply an editor change.

A lost successful push acknowledgment leaves retryable work and the previous confirmed base. A receipt-save failure does not report the new observation as confirmed; the UI retains the prior confirmed IDs/time when available and reports an unconfirmed/error state. Explicit Check or queue Retry can repair a verified observation. An uncertain filesystem replacement may already have reached disk, so reopening must validate the resulting state rather than assume rollback.

## Private receipt and verification

Local metadata schema 5 adds `serviceSyncBases`, separate from the legacy branch-only `syncBases`. Migration preserves existing project IDs, revisions, branches, and legacy bases and initializes the service-scoped list empty. It never promotes a legacy base into service evidence. Revision transfers omit this local state.

Each receipt has exactly `version`, `scope`, `localRevisionId`, `remoteRevisionId`, `remoteAuthorId`, `manifestId`, `recordHash`, `proofHash`, `verifiedAt`, `observedLocalHead`, `observedRemoteHead`, and `proofSnapshotHash`. The exact scope is `{originHash, accountId, localProjectId, localBranch, remoteProjectId, remoteBranch}`. Changing any scope component selects separate evidence. At most 10,000 service receipts are retained across local projects.

The verifier checks saved local record bytes, validated manifests, and contiguous remote root-to-head ancestry, bounded to 10,000 records and 64 MiB per bundle/snapshot. Duplicate revision/source IDs, cycles, wrong projects or branches, invalid dates/messages, and manifest/schema/hash mismatches fail closed. Known remote source IDs must retain the matching local manifest, trimmed message, and mapped parent. The shared candidate is the deepest exact common prefix; matching content alone is insufficient.

`recordHash` binds the exact local record bytes. `proofHash` binds the selected local chain, normalized complete remote observation, full scope, and verification time. The remote author's ID identifies the original authenticated publisher. It need not equal the current checking account or the local display-author label. A retry reuses immutable remote revisions without rewriting attribution.

Before recording, the controller rechecks the live remote branch head and current scope. The local writer uses expected local-head and base-version compare-and-swap checks, revalidates candidate bytes, and refuses base regression. Later checks also require every revision through the prior remote base to retain its verified fields. This protects historical continuity across observations; it does not lock either branch against later changes.

## Storage and recovery

Immutable proof files live in the full-scope private revision cache. `storeSnapshot()` validates and publishes a snapshot without changing the explicit fetched-history index; `readSnapshot(hash, {projectId, branch})` validates content and scope independently of that mutable index. Snapshot files and metadata use mode `0600`, and cache directories use `0700`. Publication flushes files and containing directories, including new cache-directory entries, before acknowledgment.

Local metadata writes flush the temporary file, backup, and directory around atomic replacements. A failure after replacement is attempted latches that metadata-store instance as uncertain until reopened. Cache publication similarly latches further publishing after an uncertain publication; a fresh instance can validate what reached disk. Neither protocol establishes hardware-specific power-loss guarantees.

On restart, the controller verifies the immutable witness and original local bytes before displaying its restored receipt. During an app session, it may reuse a successful historical verification until the scope, generation, or receipt changes. Explicit actions verify afresh. This memo is not continuous file-integrity monitoring or executable authority for apply.

A missing witness can be repaired only when fresh authenticated remote ancestry and saved local bytes reproduce the original observation's proof hash, including its original heads/time. A cached snapshot by itself cannot authorize a branch mutation, revision import, media operation, or editor apply. Corrupt or incompatible evidence remains invalid; it is not silently replaced by a weaker match.

The later [service sequence comparison](SERVICE_THREE_WAY_COMPARISON.md) consumes this verified receipt and immutable witness to compare three FCPXML sequence fields against current source-verified scan values and an explicitly fetched incoming head. It verifies the historical remote prefix, reads current local source twice, and leaves the shared-base receipt unchanged. Its result remains read-only and does not extend the receipt into clip/media identity or apply authority.

## Validation and limits

The [shared-base HTTPS observation](phase-0/service-shared-base-network-observation.json), reproduced with `node scripts/service-shared-base-proof.js`, recorded 114 requests across three host processes and three fresh client/controller processes. It verified separate owner/viewer receipts, original-publisher attribution, explicit-fetch-only display changes, restart restoration without automatic network access, and one deliberately discarded real successful branch acknowledgment. Retry repaired base 3 without duplicate revisions. A service-only fourth revision left the local head/common base at revision 3 and the legacy base at revision 1. No revisions or media were imported. Private files, logs, public state, and child-process cleanup checks passed.

All 717 tests, 273 security tests, and packaging validation passed. The [desktop observation](phase-0/service-shared-base-desktop-observation.json) records browser checks for the shared-base row and open detail updating together, a later local revision marked After shared base, advancement after another verified push, sign-out/rebinding, and viewer-specific verification with pushing disabled.

Native Electron saved and pushed a disposable revision through actual preload/IPC, then marked its row and open detail as the shared base. After a verified full quit/relaunch, the OS-backed account and matching-source binding recovered without retyping. The same local/remote IDs and recorded time returned from private proof verification while the current branch comparison remained unchecked. Live schema-4-to-5 migration preserved every existing project row across 10 projects and 20 revisions. Metadata, proof, and vault files were mode `0600`; raw fixture credentials were absent from vault bytes.

Two bounded visual rounds at 1440, 768, and 390 px showed no horizontal overflow and at least 44 px phone buttons. The redundant historical-status sentence was trimmed; the scope/current-head caveat and incumbent graphite/Plex design were retained. The mechanical check found zero primary findings and 31 existing palette advisories; no new suppressions were added. A full accessibility audit remains separate work.

Both clients signed out, the disposable service exited, temporary source/service data and private locator were removed, and the browser tab closed and viewport reset. No native media-transfer directory was created. The ordinary app reopened signed out without test certificate trust. Native disposable read-only history and scoped proof files remain in the app’s private metadata; no service account remains saved. The browser used fixture picker/vault adapters; native IPC and OS-vault evidence were separate.

The proof used a disposable CA on numeric loopback, trusted only in isolated workers, and graceful process shutdown after committed operations. That process proof does not establish production hosting, Electron vault behavior, a crash during a write, or machine power-loss recovery; native vault evidence is recorded separately above. Editor identity/semantics, source freshness, canonical media binding, revision import/reconciliation, and safe apply remain separate requirements.
