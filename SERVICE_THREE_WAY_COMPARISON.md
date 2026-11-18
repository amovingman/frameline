# Service sequence comparison

History's **Sequence comparison** compares three verified FCPXML observations: the recorded shared base, the current selected scan, and the last explicitly fetched service head. It classifies sequence name, frame duration, and sequence length in frames. The result is read-only, remains in memory, and cannot apply edits.

## Workflow and coverage

Sign in, link the selected local branch to a service branch, and establish a [service-scoped shared base](SERVICE_SHARED_BASES.md). Choose **Fetch history** to capture incoming metadata. Scan or rescan the local export, then choose **Compare sequence**. Current local changes may be unsaved in History; the comparison verifies the selected export's actual bytes without recording a new revision.

The UI shows base/current/incoming values for changed supported fields:

| Observed values | Classification |
| --- | --- |
| Local equals base; incoming differs | Incoming change |
| Incoming equals base; local differs | Local change |
| Local and incoming made the same change | Same change observed |
| Both differ from base and from each other | Different local and incoming changes |

Unchanged fields are omitted. Frame durations use exact reduced rational values, so `2/48s` and `1/24s` compare equally. Sequence lengths are frame counts; a frame-rate change can also change elapsed duration. A classification does not prove that anything was applied to an editor. The internal `already-applied` status is displayed as **Same change observed** for this reason.

The source details show revision IDs, source hashes, comparison/fetch times, clip/media counts, and media-label ambiguity. Inventory and availability observations are context only. No clip pairing, clip addition/deletion/property classification, media identity, or media-edit classification is provided. Positional scan keys are not persistent clip IDs. Scan warnings and unsupported editor coverage remain explicit. Resolve observation manifests are refused by this comparison; the separate Resolve preview retains its own compatibility and coverage rules.

## Provenance and staleness

Compare makes no network request. It requires a valid shared-base receipt and an explicitly fetched incoming snapshot; a proof-only Check/Push snapshot does not satisfy that requirement. A newer service head is not automatically substituted. Fetch again to capture newer incoming history, then compare again.

The main process validates the exact base proof snapshot against its recorded hash, reconstructs the historical receipt from local bytes, and verifies the base is on the selected local ancestry. Incoming metadata must have contiguous, project-bound root-to-head ancestry and retain the exact historical remote prefix through that base. Canonical manifest hashes, schemas, known source-ID mappings, and record hashes are checked. A matching source ID or similar sequence name alone is insufficient.

The current local callback captures project, branch, saved head, and the ready scan manifest, then rereads the selected export to verify its source hash. The controller calls it before and after comparison and rechecks the local bundle, receipt, incoming cache, and full origin/account/local/remote branch scope. A changed source, head, receipt, cache, or selection prevents publication of a result. A failed comparison clears its earlier result and reports a bounded error.

Results are captured observations rather than continuous source or service monitoring. Changes outside the app after capture require another scan/fetch/comparison as appropriate. Selection/account/binding changes invalidate the scope. Later local-head, receipt, or fetched-cache changes suppress an incompatible displayed result. Results do not automatically recover after restarting the app; the user compares again against restored, verified metadata and freshly checked local source bytes.

## Boundaries and storage

`createServiceThreeWayComparison()` accepts exact `{scope, baseEntry, bundle, baseProof, incoming, local}` input. It uses the existing six-part shared-base scope. Each serialized input is bounded to 64 MiB, ancestry to 10,000 records, and the internal result to 1 MiB. Its verifier recalculates the result against the same inputs. The main process retains proof bindings privately and returns an explicit display projection with safe values, source hashes, IDs, timestamps, counts, and warnings.

Compare does not write the source, save a revision, import incoming revisions, change a branch or shared-base receipt, update the fetched-history index, or transfer media. It neither produces a merged project nor emits `pull.completed`. Source-hash verification establishes the exported bytes used for this observation; it does not establish live editor freshness, complete project semantics, or apply readiness. The broader three-way pull-planning and safe-apply gates remain open.

## Validation

The [recorded network observation](phase-0/service-three-way-network-observation.json) passed 41 actual HTTPS requests across two host processes and two fresh client/controller processes. `node scripts/service-three-way-proof.js` reproduces it; its dedicated test also passed. The fixture uses actual FCPXML scans, a common saved root, independent local/service children, and unsaved current local changes. It verifies all four statuses, rational equivalence, refusal without explicit Fetch, cached incoming after restart despite a newer service head, and replacement only after Fetch.

Before/after request counters and file hashes prove successful Compare performs no network dispatch or source/metadata/cache/base write. Source edits without rescan and edits between the two verification callbacks both fail. Local/service heads and the legacy base are preserved. No revisions or media are imported. Private-file permissions, safe logs, terminal child-process checks, and cleanup passed.

The [desktop observation](phase-0/service-three-way-desktop-observation.json) records two browser rounds showing conflict/incoming-length rows at 1440, 768, and 390 px with no horizontal overflow; buttons were 38, 38, and 44 px respectively. Final checks verified source hashes, base/incoming/local saved-head IDs, inventory disclosure, and recovery copy. A viewer signed in and linked its own scope, required its own explicit Fetch before Compare, saw the correct conflict/incoming length, and could not push. Sign-out hid the comparison.

Native Electron used actual IPC and the OS-backed account connection to save/push one common-root revision, fetch an independently added service child, and compare unsaved local export changes. Compare refused the stale original scan, then Rescan/Compare showed the expected name conflict and incoming length change while the local revision count stayed one.

After the native app exited successfully and relaunched, OS-backed credentials, the matching binding/base, and the two-revision fetched cache recovered without retyping. The local history still contained one root revision. No comparison was automatically restored; explicit Compare recomputed the unsaved local name versus incoming-name conflict and incoming sequence length of 480 to 504 frames. A later newline-only source edit caused refresh to refuse the stale source, clear the result, and direct the user to rescan before comparing again. Sign-out cleared the panel and restored the Local revision label; test credentials were removed. This is bounded sequence evidence rather than a full-project or editor-apply check.

All 740 full-suite tests, 294 security tests, packaging, and final browser/native checks passed with no test skips. The native vault remained mode `0600` with zero entries after sign-out, and the ordinary app relaunched signed out without test certificate trust. Both fixture processes exited successfully before temporary source/service cleanup; browser tabs closed and the viewport reset. Disposable native revision/proof history remains intentionally in private local metadata.

The network fixture uses a disposable CA trusted only in isolated workers on numeric loopback and a private fixture connection adapter; native IPC/OS-vault evidence is separate. These checks do not establish production hosting, complete editor behavior, apply safety, or power-loss recovery.
