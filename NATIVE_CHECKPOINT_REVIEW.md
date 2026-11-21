# Native checkpoint identity and three-way review

Five roadmap items are complete for verified closed checkpoints from the installed Resolve Free 21.1.2 build 21.1.20010 on macOS: durable identity mapping, stable-ID matching, stored-field change detection, common-base/current/incoming comparison, and change classification. This is a read-only native database workflow. FCPXML identity across changed exports, unsaved editor identity, complete interpretation of opaque fields, and additional executable edit types remain unsupported.

## Workflow

In Resolve preview, use **Native checkpoint review → Capture closed project** and select a canonical `Project.db` from a configured local disk library. Resolve must be quit. The fixed read-only helper extracts the sole project UUID/name; the host verifies the installed editor, process/file absence, source identity, metadata, library and exact database/census bytes before retaining a checkpoint.

Choose a **Recorded common base** and an **Incoming retained checkpoint**. Related checkpoints from the same captured lineage can be selected directly. To use a separately validated review copy, select its completed transaction and choose **Capture as incoming branch**. Matching names or editor UUIDs alone never establish shared ancestry across libraries.

Choose **Compare with current local project**. The host captures the current original again, checks that the selected base is its ancestor, verifies the local bytes before and after the full comparison, and reads the retained incoming revision from authenticated private artifacts. Incoming is explicitly historical. Switching roles or a failed freshness check clears the comparison. Filtering happens before 40-row paging.

Rows show incoming-only, local-only, already-applied or conflicting changes, with base/current/incoming values. Safe clip Names and exact numeric values are displayed; other text and opaque values use types, byte counts and hashes so media paths and raw blobs do not enter the renderer. Known native entities show generated application IDs and generations beside the changed field. Identical fields contribute to the unchanged count without filling the change list.

## Identity sidecar

The host keeps mode-0700 directories, mode-0600 artifacts, a private authentication key, immutable checkpoint records and an authenticated append-only identity-state chain. Checkpoints bind exact database and full census hashes, their parent, the project/library/path scope, and the project/timeline/sequence/track/item UUID graph with strict primary-key and parent joins.

Generated application UUIDs persist across observed Names, other stored properties, track moves and restart. An entity observed deleted and later recreated under the same native UUID gets a new application ID, generation and comparison token. The comparison refuses incompatible generations. A process interrupted after recording a checkpoint or committing state can recover without inventing identities or replaying writes.

A copied project is a separate library-qualified identity, even when every editor UUID is identical. Only a completed authenticated native review-copy transaction can establish a fork: its original hash must match the recorded source checkpoint, its destination/hash/native proof must match the captured copy, and its identity graph must be unchanged. Fork entities receive distinct application IDs but inherit source comparison tokens. This also handles a source entity already at a later generation. Unverified copied databases are never silently merged into original history.

## Smallest safe comparison

The engine validates the complete typed census and compares every persistent table, schema object and application pragma, with no application columns excluded. Primary-key rows support field-level comparison. Primary-key changes are additions/deletions; deletion versus a concurrent edit is a conflict. Tables without usable keys retain duplicate rows as atomic multisets, without positional or rowid identity guesses. Physical storage metadata is reported separately.

NULL, empty BLOB/text, invalid-UTF-8 text bytes, integers and exact IEEE floating-point encodings stay distinct. Opaque blobs are whole atomic cells. Schema and unkeyed structural changes are conservative atomic scopes. Deterministic full-report hashes and verified paging preserve complete comparison before limiting displayed rows. The comparator is bounded and refuses excess work rather than truncating the comparison silently.

The five classifications are derived from exact values: unchanged when all three match; incoming-only when local equals base; local-only when incoming equals base; already-applied when both sides match a changed value; conflicting when both differ from each other and base. These classifications are not permission to write. Existing Name Apply and review-copy guards remain separate.

## Evidence

- [Native checkpoint proof](phase-0/native-checkpoints-live-proof.json): 77 persistent entities, 9,788 stored cells, 146 tables and 596 schema objects produced 11,673 comparison coordinates. The actual original and its validated copy yielded exactly one incoming-only Name change. Original and copy bytes stayed unchanged; generated IDs and the complete report remained identical in a second host process.
- `npm run audit:native-checkpoints-live` verifies authenticated retained checkpoints, source hashes, copy ancestry, stable IDs/tokens, exact report reproduction and a fresh original-file check. Private databases, censuses, identity keys and journals remain in ignored `phase-0/private-integration-proof/native-checkpoints-20261121`.
- [Desktop proof](phase-0/native-checkpoints-desktop/verification.json): two real Electron processes exercised the shipped main/preload/renderer/controller with the actual sidecar and SQLite/diff helpers; hardware observations were synthetic. A source fixture produced 21 conflicts and 40 incoming-only changes, verified filtering/paging, unchanged source bytes, stable IDs/reports after restart, path-free state and 600/1440px layouts.
- Focused tests cover opaque values, independent edits, additions/deletions, unkeyed duplicates, rowid changes, generation reuse, verified forks, stale source/parent/library, corrupted records, actual process death and interrupted commit recovery.

Final validation passed 2,171 repository tests with no failures or skips, 44 focused checkpoint tests, and the package archive check.
