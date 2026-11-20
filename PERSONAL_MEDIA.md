# Revision media for the personal project

This workflow completes five Phase 4 media items for the current owner-only, local/self-hosted scope: deduplication across revisions/projects, six availability states, selected-revision downloads, retention-aware garbage collection, and owner export/deletion reports. It uses the existing HTTPS service and command-line clients. The desktop's older lifecycle panel continues to offer its conservative, non-executable plans.

## Canonical media requirements

`npm run service:revision-media --silent` reads one JSON request from stdin. Every request has `origin`, `accessToken`, `projectId`, `action`, and `input`. The origin must be HTTPS. Credentials stay in stdin; stdout contains a path-free JSON result. Local input paths are used only to read sources or write selected downloads. Errors and progress omit paths and credentials.

First use `action: "inspect"` with these publication settings:

```json
{
  "exportPath": "/absolute/disposable/timeline.fcpxml",
  "branch": "main",
  "expectedHead": null,
  "message": "Small media revision",
  "idempotencyKey": "small-media-1",
  "uploadMedia": false
}
```

Capture rescans the selected FCPXML, recursively inventories referenced original media, streams SHA-256 fingerprints, and rechecks the export and file identities. Supported complete captures produce scan-manifest schema 3 with `mediaDependencies`. Each requirement contains an export-scoped reference number, complete content identity, size/class, and required flag. No media URL or local location enters the immutable manifest. Its service manifest hash and ordinary local revision record hash cover the dependencies as well as the scan. Reference numbers do not establish persistent editor clip identity.

`exportPath` accepts an ordinary `.fcpxml` file or a Resolve `.fcpxmld` directory containing `Info.fcpxml`.

Missing originals, unresolved references, unsupported dependency-bearing structures, and uncertain coverage produce an explicitly incomplete capture. Those revisions cannot authorize a complete download or garbage collection. Legacy FCPXML and Resolve observation revisions remain readable; they lack canonical media coverage and conservatively block collection for their project. Every immutable revision is retained, including revisions outside the current branch ancestry. There is no revision-pruning operation in this workflow.

Media upload is explicit. `uploadMedia: false` publishes metadata and requirements without transmitting media bytes. With `uploadMedia: true`, the workflow uploads and verifies the required content before publishing; the server rechecks the required project assets under the same asset lock used by garbage collection. Publication also uses branch compare-and-swap and account-scoped exact-input retry keys.

Inspect returns the exact canonical metadata, actual source basenames, unique media identities/bytes and a `reviewHash`, without upload or metadata-write requests. After reviewing it, use `action: "publish"` with the same settings plus that `reviewHash`. Both upload choices require the review hash. Publication rechecks source/media, destination, account, branch/head, message and upload choice before writing; changed inputs require a new inspection. See [publication privacy](OWNER_OPERATIONS.md).

The existing project class policy must already allow the selected class. Capture currently identifies referenced originals as `original`; it never infers that a proxy is a camera original. Use `policy-get` with `{}` and then explicitly consent with `policy-set`, for example:

```json
{"expectedVersion":0,"syncClasses":["original"]}
```

Use the version returned by the service. Publication does not change that policy automatically.

## Storage boundary and deduplication

Cross-project physical reuse is disabled by default. Enable it explicitly in the private service configuration:

```json
"assets": {
  "directory": "/absolute/private/media-store",
  "signingKey": "BASE64_ENCODED_32_BYTE_KEY",
  "ownerBoundaryDeduplication": true
}
```

The boundary is projects owned by the same currently authenticated account on this installation. The destination and source project require independent owner authorization. Full identities, including size, class, and media type, must agree. Content lookup never gives another project access merely because it knows a hash. Encrypted physical blobs can back separate project upload/publication records, so deleting one project's reference leaves the other project intact. Uploads within a project already reuse matching content across revisions.

Asset-index schema 5 migrates older encrypted indexes while preserving bytes, archive clocks, holds, jobs, and receipts. Chunk ciphertext retains its original authenticated storage identity when a second project references the backing blob.

## Availability and selected downloads

The `availability` action takes `revisionId`, optional `localFiles`, and optional `collaboratorObservation`. The workflow fetches that exact immutable revision and manifest, recomputes its manifest hash, then combines freshly hashed local files with current service availability and class policy.

The states are `cloud-present`, `collaborator-only`, `local-only`, `missing`, `excluded`, and `archived`. Evidence flags remain available when more than one condition holds. The report says `scope: "checked-locations"`: missing means no known copy among the checked locations. Network failures remain errors. They do not become missing-media findings.

Collaborator presence is an explicit owner-attested observation, not an authenticated live-device claim. An observation must name the exact project, revision and manifest, contain only matching full asset identities, and have an observation/expiry interval of at most 24 hours. Expired, future-dated, mismatched, or malformed observations are rejected. No additional user is needed to develop or test this optional evidence input.

The `download` action takes:

```json
{
  "revisionId": "IMMUTABLE_REVISION_ID",
  "destinationDirectory": "/absolute/disposable/downloads",
  "workDirectory": "/absolute/private/transfer-checkpoints",
  "localFiles": []
}
```

Only required identities from that selected revision are considered. Verified local content is skipped after a fresh hash check. Required unavailable, excluded, archived, or incomplete dependencies block the operation. Each downloaded asset passes chunk and whole-file verification before exclusive publication under its content hash; existing files are not overwritten. Transfers use the existing resumable checkpoints, cancellation, and optional `maxBytesPerSecond` controls. A changed revision/manifest or account scope cannot silently substitute a different download set.

Downloads collect verified media bytes. They do not rewrite Resolve projects or perform editor relinking; the separate proxy/relink roadmap item remains open.

## Owner reports and reviewed deletion

`npm run service:asset-lifecycle --silent` accepts the existing stdin request envelope. The new actions are `owner-report`, `gc-plan`, and `gc-execute`; existing holds, releases, retention settings, archive/restore, and legacy blocked-plan endpoints remain available.

An `owner-report` input is `{"afterAssetId":null,"limit":100}`. Follow `nextAssetId` for further pages, requiring the same `stateHash` when collecting one consistent report. Exporting stdout preserves the exact validated report pages. Reports include full content identities, retained revision IDs, missing retained assets, archive age, holds, shared-content status, eligible bytes, reference coverage, and pending physical cleanup bytes. Other projects' IDs, credentials, and filesystem locations are omitted.

Byte totals measure original payload bytes. Fields named `physicalBytesReclaimable`, `physicalBytesScheduled`, and `pendingPhysicalBytes` count payloads with uniquely reclaimable or pending backing blobs; they exclude encryption/base64/filesystem overhead and do not claim measured disk space freed.

For `gc-plan`, supply the chosen `assetIds` and the reviewed report's `expectedStateHash`. For `gc-execute`, supply those same values, the returned `planId`, and a new `idempotencyKey`. This is the explicit deletion action. The server recomputes the plan and rejects stale reviews or blocked candidates.

Collection requires an archived asset, an elapsed retention period, no active hold, no queued/running verification, complete retained-reference coverage, and no retained revision reference to the content. Metadata-only missing assets are reported explicitly. Shared physical content remains while another project/upload needs it. The history metadata lease remains held through the durable asset-index commit; publication and collection use the same lock order.

Incomplete resumable uploads remain available for retry and are outside the explicit published-asset collection set. Collection does not sweep arbitrary files or unrecognized storage entries.

Deletion first commits project-reference removal, tombstones, an exact-input receipt, and pending physical work in the encrypted index. Only then can unreferenced ciphertext be removed. An uncertain metadata publication retains bytes and requires a verified reopen. Interrupted physical cleanup remains discoverable and retryable; the owner report distinguishes pending bytes from completed physical cleanup. An exact retry returns the original deletion receipt without executing a new logical deletion.

The desktop lifecycle panel now uses these authoritative schema-2 reports and plans too, with explicit collection, durable retry/receipt recovery and reviewed exports. The original schema-1 blocked-plan endpoints remain available for legacy clients. See [owner operations](OWNER_OPERATIONS.md).

## Validation scope

Small disposable fixtures exercise the capture, immutable-history/backup bindings, checked-location evidence, HTTPS clients, encrypted service, cross-project physical reuse, selected downloads, retained-reference protection, stale plans, deletion/retry, and service restart. Tests use synthetic media bytes and disposable accounts. They do not establish ordinary Resolve apply, persistent editor identity, camera-original/proxy relinking, managed hosting, or public-release readiness.

The final build passed all 1,607 regression tests, 1,147 security checks, 163 migration checks and three fixture checks, without skips. Universal macOS helper packaging and archive verification passed; `npm audit --omit=dev --audit-level=high` reported no vulnerabilities.

Run `npm run test:revision-media` for the focused batch. The [HTTPS observation](phase-0/personal-media-https-observation.json) is reproduced with:

```sh
FRAMELINE_PERSONAL_MEDIA_EVIDENCE="$PWD/phase-0/personal-media-https-observation.json" node --test tests/personal-media-https.test.js
```
