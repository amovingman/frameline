# Native field preservation research

The lossless-field roadmap checkbox is complete for the controlled closed-copy, existing-custom video-item Name workflow described below. The target is the installed Resolve Free 21.1.2/build 21.1.20010 on macOS. A correct target name, equal API captures and unchanged rendered output would each leave API-invisible fields unverified. Ordinary Apply remains disabled.

## Byte-preserving native writer

`native-preserving-name-writer.py` resolves a project/timeline/item UUID through the saved native graph, locates the item's sole direct `Name` text span, and edits that span without serializing the XML. It preserves every other decompressed member byte, including opaque payloads, unknown binary members, comments, attributes and text. Untouched compressed local ZIP records remain identical. Only the target compressed stream and necessary ZIP CRC, size and offset fields change. Unsupported ZIP extensions and ambiguous identities refuse; output is exclusive, private and source-bound.

`native-preservation-acceptance.js` independently compares raw member names, order and contents. Its single authorized name span does not authorize another changed byte. Identity binding, ZIP envelope preservation and actual editor execution require separate evidence; supplied byte arrays or caller flags cannot establish them. The initial five-member synthetic archive test preserves four members exactly and changes only the declared name span in the fifth. This proves the writer boundary, not an editor round trip.

`resolve-native-byte-census.py` accounts for every original archive and uncompressed member byte. Lexical XML ranges are diagnostic locations, not a rewritten or normalized document. Unsupported markup and binary members remain complete opaque ranges. No field is dropped because its format is unknown.

## Isolated editor controls

A separately named preservation project was imported from the verified restored enumeration fixture. The original project was guarded, saved and backed up first. Creation of the new baseline is not a preservation result. Resolve reassigned the imported project, timeline and clip UUIDs; importing a DRP cannot be assumed to preserve their identities.

The new project has two timelines, twelve tracks, sixty occurrences, seven applied effect slots and four directed link relationships. Its represented owner inventories match across save/reopen. Native archives were retained immediately after import before timeline reads, after reads, after save, after reopen before reads, and after reopened reads. All four adjacent comparisons change four of five native members. A gallery member remains equal. These differences include opaque fields and newly materialized native nodes, not merely ZIP timestamps.

The older read-only, save/reopen and rollback controls also retain unexplained native differences. A valid compressed transition payload can be decompressed, and some other bytes resemble clock values, but neither observation establishes their meaning or permits excluding them. The public SDK supplies no complete native serialization contract.

## Authoritative database investigation

The next route compares closed snapshots of the disposable project's local `Project.db`. This can distinguish persisted application fields from values synthesized by DRP export. The snapshot tools read the library without SQL writes, native database patches or schema changes. A separate fallback writer edits only a new private copy and cannot publish it to the library.

The intended comparison includes every schema object, table, row, column, storage type and opaque BLOB. It must account for unknown data, duplicate rows and identity-bound name changes. SQLite container representation is distinct from application values; no native BLOB can be exempted merely because it changes during a control. Snapshot provenance must include a guarded editor close and source identity verification before reopening.

Primary SQLite references describe [read-only URI access](https://www.sqlite.org/uri.html), [consistent backup snapshots](https://www.sqlite.org/backup.html), and the [database format and journal/WAL state](https://www.sqlite.org/fileformat.html). These specify SQLite behavior, not the semantics of Resolve's private columns or blobs.

## Binary transport calibration

The internal Lua environment does not expose standard `io`, `require` or FFI. `IOClass.Read(n)` returns a MemBlock and byte count; its equality operator compares object identity, and its string conversion describes the allocation. Neither establishes content equality. `ReadLine` drops binary data and is rejected for database reads.

A private 294-byte sentinel containing all byte values, NUL, CR and LF was read into a live MemBlock and written through `IOClass.Write(buffer, count)`. The host verified the output against every original byte, its exact length and digest. This proves binary pass-through, not an in-script string reader or a preservation result. A separately reviewed Python sentinel program passed host tests but was not exposed by this Free installation's Scripts menu; it has no native Python result.

The next measured transaction uses one bounded host admission while the same native invocation holds the source descriptor and buffer. The host must verify both the native pass-through copy and the closed live source against the retained baseline before issuing an exclusive, source-bound ticket. Native identity and stale-name checks remain necessary before the setter. This measurement assumes no concurrent external project writer; an open descriptor and a ticket do not make the editor's later path-based load atomic. The post-close all-cell comparison remains the preservation authority.

A fallback `native-sqlite-name-copy.py` can change one stale-checked, primary-key-bound Name cell in a new private copy. The frozen comparator verifies every other typed cell and schema object. A copy of the actual baseline passed this check. The source snapshot remains unchanged, trigger side effects refuse, and reused output directories refuse. This is preparation evidence only: library publication, an editor load, a persisted-name read and a complete post-close comparison have not occurred.

## Interrupted SDK transaction

The admitted same-project Name transaction copied and host-verified all 2,945,024 source bytes before Load. It wrote its start barrier, then Resolve crashed with signal 11 before any completion/error/close marker. The runtime log reports saving and a subsequent placeholder transition, but it cannot establish the exact failing call or turn the interrupted program into verified Save/Close completion. The invocation is never replayed.

A private forensic snapshot has the same 146 tables, 596 schema objects, 540 rows and 9,788 typed cells. Ten cells in four tables changed: the authorized Name and nine further values. These include opaque configuration/sequence/item blobs and an empty-blob-to-NULL change. Schema and application pragmas remain equal. The strict Name-only comparison fails; no timestamp or opaque-byte exemption is introduced. The source-bound failure auditor recomputes these deltas from complete hashed typed-cell projections.

Recovery admits a new stored baseline only after a separate fresh native absence observation and a verified raw snapshot. It preserves the interrupted program and false Save/Close-completion flags. Its expected Name locators are derived projections, not new rich API captures. The next workflow edits a private copy, verifies every other application value, publishes only the owned closed fixture with a full backup, loads it for a basic UUID/Name check, and uses a separate close/absence/snapshot measurement. Gate completion still requires that final editor round trip.

## First successful closed-copy editor round trip

The post-crash stored baseline was independently admitted through a fresh source-absence capture. A private copy changed the existing custom Name to a second custom Name on the same UUID-bound video item. Complete comparison preserved all other 9,788 typed cells, 596 schema objects, 540 rows and 146 tables. Guarded publication retained an exact backup and preserved every source extended attribute; macOS added its own provenance attribute to the replacement, so whole-file metadata equality is explicitly false.

The source-bound load-only script verified the exact published bytes through host admission, loaded the same project, and observed the intended Name on the bound item. It completed with zero content setters, Save calls or Close calls. The project was then closed through Resolve's File → Close Project UI without a Save prompt. A new, separately issued source-absence diagnostic succeeded before the final raw database snapshot.

The entire post-close database is byte-for-byte identical to the published candidate: SHA-256 `fa99fea80a0e7556c54b3abd74827aa9f2645b75bb5c8d2cf6a17876b988464c`, 2,945,024 bytes. This establishes the first successful editor round trip for the controlled closed-copy, existing-custom-Name workflow. It does not repair the earlier SDK transaction's nine unrelated changes, establish SDK Save preservation, or enable ordinary Apply. The consolidated `preservation-closed-copy-evidence.js` auditor pins the executed sources and receipts, independently binds the complete UUID/foreign-key chain, compares every typed-cell commitment, and verifies the single authorized Name change and byte-identical post-editor database. Public evidence contains hashes rather than raw project data; complete original artifacts are retained privately.
