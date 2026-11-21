# Localized native opaque-field evidence

The new read-only diagnostic localizes selected native payload records under their explicit `DbId` owners. It retains complete untouched member/archive hashes and records hashes of parsed text, attributes and observed shape for `FieldsBlob`, `Body`, `BtMetadataLockableBlob`, `BlobOwner` and `BtThumnail`. It never edits an archive, assigns a semantic meaning to a blob or ignores a difference.

The bounded existing native archive/XML readers supply size limits, no-follow input checks, CRC verification and the parser-only adaptation for C++ element names. Public output omits native member paths, names and payload values. Hex text is decoded only to count/hash octets. Nested payload contents remain uninspected; equal observed text and child counts do not prove equal nested content.

```sh
python3 phase-0/resolve-native-field-inventory.py inventory /absolute/private/project.drp /absolute/private/api-observation.json
python3 phase-0/resolve-native-field-inventory.py compare /absolute/private/before.drp /absolute/private/after.drp /absolute/private/api-observation.json
```

The optional API input is schema-validated and must have the same project UUID. `containingApiItemIdMatch` requires a native item element and a UUID matching an API item; it does not independently prove complete timeline parentage. Ancestor-match changes are reported separately from payload differences. Reparenting an unchanged nested owner between two API items cannot silently become an equality result.

Member filenames are locations. A same-owner field can retain its diagnostic key across a member rename, with that relocation recorded separately. Duplicate ambiguous owner/relative locations refuse inspection. Added or removed owner records remain unpaired; the comparison never guesses a replacement from position or equal bytes.

## Read-only export control

The [fresh track read-only interval](native-track-readonly-live-observation.json) captured the complete rich API state before, between and after two exports. All three captures matched, and it made no project save, load or mutation call. The two native archives have SHA-256 `49fae0cdbdf9c3cbf86d88f3ea3d7c80e313d28337f318989c41f664f4779f93` and `db1439fce5693878a7a28394237053dd55a8790ea7fd420ff42c9b3d86f7fbd0`.

The [retained parsed evidence](native-field-control-evidence/receipt.json) contains **430 selected field records per export**. Comparison reports **150 added records, 150 removed records and one paired parsed-payload difference**. Native member bytes differ. These are diagnostic record differences; the unpaired records are not asserted to be 150 changed semantic properties or 150 changed editor objects.

The control shows why equal API captures cannot establish opaque native equality. It does not establish that differences are harmless, volatile, corrupted or caused by any particular getter/export behavior. No fields are normalized away because they also change in a control.

`auditNativeFieldControlEvidence()` in [native-field-control-evidence.js](native-field-control-evidence.js) verifies fixed receipt/source/raw hashes, recomputes record, location and ancestor-match differences, and checks the API interval and native-archive digests against the independently retained read-only proof. Original DRP bytes stay private; public tests recompute pinned parsed facts rather than reconstructing private native archives.

Six structural/adversarial Python checks cover payload changes, UUID context, member relocation, reparenting, ambiguous records, unsafe inputs, privacy and unobserved nested changes. JavaScript checks additionally reject changed public facts, sources or receipts. `losslessValidated`, complete-field coverage and ordinary Apply remain false.
