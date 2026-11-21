# Native review-copy workflow

The four review-copy roadmap items are complete for one reviewed existing video clip Name change on the owner's Resolve Free 21.1.2 build 21.1.20010 on macOS. This extends the [in-place workflow](SAFE_APPLY.md) to a different configured local disk library. Other edit types, imported UUID remapping, portable copies and other editor versions remain unsupported.

## Create and validate a copy

1. In Resolve’s Project Manager, create or connect a separate local disk library. Select that destination library and quit Resolve. It must not contain a project with the original project’s name. Empty libraries are supported.
2. In Frameline’s Resolve preview, finish the snapshot review for one video clip Name change. Choose **Create review copy**, then **Choose original and review library**. Select the closed original `Project.db` and the root folder of that different connected library.
3. Review the exact clip change, destination library and media report. Choose to keep existing media references on this Mac before **Create changed copy**. The copy preserves the original project name and UUID graph in the separate library; its retained lineage records the library separately.
4. Choose **Open copy in Resolve**. From an empty workspace in the already-selected destination library, run the named **Frameline Open Review Copy** script under Workspace → Scripts, then click **Read open result** in Frameline. A named or populated workspace is refused. If you open the copy manually in Project Manager, continue directly with the separate copy check.
5. Run the named copy-check script and click **Read copy check** while it waits. The host verifies Resolve’s actual open database path/device/inode/hash, selected library and process start before native project/timeline/item/name readback.
6. Close the project without saving, quit Resolve, and choose **Finish copy validation**. **Show copy location** reveals the verified destination. Retained records survive restart and **Inspect retained copy** reconciles actual bytes without repeating publication.

A failed one-use open/check command receives a fresh retained attempt when prepared again with Resolve closed. After an interruption, an uncertain, divergent or incomplete destination remains retained for inspection. No existing destination is replaced or automatically deleted. Preparation can be cancelled before publication.

## Original, identity and media policy

The service binds the same executable Name plan and full source/review hashes used by in-place Apply. It snapshots the original, prepares a private candidate and compares every other persistent typed cell, schema object and application pragma. Publication exclusively creates a new project directory and atomically links a verified file without replacing an existing pathname. Permissions, ownership and the complete xattr set are preserved.

The original is opened only for reading. Its exact file identity, bytes and metadata are checked throughout; the original local revision graph, branch heads and sync bases are also snapshotted and rechecked. A review copy produces its own library-qualified retained outcome and does not advance the original branch or sync base. Duplicate editor UUIDs do not establish cross-library history identity; the review-copy workflow does not import its observations into the original branch automatically.

Media policy is **same Mac, unchanged stored references**. The complete typed-cell comparison preserves explicit paths and opaque media/proxy records without interpreting or rewriting blobs. The report checks explicit item paths and labels missing or unknown media. It does not establish complete media enumeration or portability. The native fixture retained 58 explicit references: 8 available and 50 already missing, plus 363 opaque media cells. The copy preserves that existing condition.

For collection, the interface offers Resolve’s media-management/project-archive steps. Collect or relink in Resolve, verify source/proxy choices there, then capture and prepare a new review from that project. Frameline does not silently substitute proxies, collect unenumerated files or promise a portable project.

Application locks serialize this workflow and in-place Apply. The supported workflow assumes no unrelated concurrent writer starts after the final observation.

## Evidence

- [Native copy proof](phase-0/native-review-copy-live-proof.json): the production service published the reviewed Name into an isolated library; the guarded opener loaded it in Resolve; separate actual-file readback and final closed checks completed. Original bytes/identity/metadata and a real nonempty local revision/sync-base store stayed unchanged. The retained metadata file also remained byte-identical.
- `npm run audit:review-copy-live` verifies the authenticated retained journal, native proof bindings, source hashes, candidate, original, destination and unchanged history. Raw databases, journals, keys and earlier attempts remain under the ignored `phase-0/private-integration-proof/review-copy-20261121` directory.
- [Desktop proof](phase-0/native-review-copy-desktop/verification.json): two Electron processes exercised shipped IPC/UI/controller and real native SQLite helpers with synthetic hardware observations, including restart, cancellation, media choice, open/read/validation and 600/1440px layouts.
- Focused tests cover exclusive publication races, actual process death, source/sync-base drift, metadata, empty libraries, authenticated records, native command replay, unsupported current work, media coverage and path-free UI states.

Final validation passed 2,127 repository tests with no failures or skips, 54 focused review-copy tests, and the package archive check.
