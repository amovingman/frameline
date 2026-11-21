# Personal compatibility and saved-project corpus

The personal support set contains one editor target: **DaVinci Resolve Free 21.1.2, build 21.1.20010, on macOS**. Resolve's internal API reports `21.1.2.10`. The currently observed owner machine is **macOS 15.6.1, build 24G90, arm64**. The checked-in host observation comes from the installed application plist, `sw_vers` and `uname`; the auditor can repeat it without starting Resolve.

That exact OS patch is a current observation. The earlier editor experiments recorded macOS without its patch/build, so this catalog does not assign today's OS version to historical results. No other macOS patch, Intel Mac, Windows machine, Studio edition, Resolve build or FCPXML version is covered by this personal declaration. There is no public release support range: `releaseSupportRange` remains `null`, and `releaseVersionCoverageProven` remains `false`.

## Operations

Compatibility is specific to an operation and its proven profile. The private Resolve SQLite schema has no public format-version promise; the catalog records the exact complete schema/cell census commitments of the retained databases.

| Operation | Input and personal profile | Supported boundary | Evidence |
|---|---|---|---|
| Picture scan | FCPXML 1.10, regular `.fcpxml` or `.fcpxmld/Info.fcpxml`, at most 20 MiB | First sequence's top-level picture clips and exact rational frame timing. Unsupported nested content, audio and additional lanes remain omitted with warnings. Occurrence identity is unresolved. | Four untouched editor exports in the catalog; [scanner boundary](phase-0/SUPPORT_MATRIX.md), [large-project evidence](LARGE_PROJECTS.md) |
| Native checkpoint review | Saved flat native checkpoints on the exact build | Complete stored cell/schema census and authenticated saved UUID/generation joins. Unsaved state and interpretation of opaque effect graphs are outside the profile. | [native checkpoint review](NATIVE_CHECKPOINT_REVIEW.md), [saved identity](RESOLVE_IDENTITY_AUTHORITY.md), [outer enumeration](phase-0/RESOLVE_TIMELINE_ENUMERATION.md) |
| Native Name Apply | One existing video item's stored `Name` | A closed, source-bound project; exact original backup; one checked UUID/foreign-key target; all other application values preserved; atomic publication; native editor readback and separate closed validation; tested restoration. SDK Save is not the preservation path. | [safe Apply](SAFE_APPLY.md), retained originalB census and authenticated restoration |
| Native Name review copy | The same single-field profile in a new verified disk-library copy | Original source/history remain unchanged. Media references stay on the same machine; collection and portable media availability are not established. | [review copy](NATIVE_REVIEW_COPY.md), [native-copy proof](phase-0/native-review-copy-live-proof.json) |
| Native Name pull | Same-lineage base/local/incoming saved checkpoints | Complete three-way classification, required explicit conflict choices, at most one effective supported Name edit, source refresh, durable recovery and editor validation. Unsupported accepted changes block execution. | [native pull](NATIVE_PULL.md), [conflict result history](NATIVE_RESULT_AUDIT.md) |
| Native result history | Validated native Name results | Historical exact decisions, source bindings and both Apply/restoration revisions. Canonical portable exports have no Apply or restoration authority. | [result audits](NATIVE_RESULT_AUDIT.md), [four-cycle proof](phase-0/native-result-live-proof.json) |
| Proxy-safe review copy | FCPXML 1.10 flat picture sequence with explicit original/proxy roles | Byte-preserved reference patch in a new XML file, then a uniquely created derived project. Three admissions, 50 exact picture occurrences, role paths and frames, actual Save/reopen/Close and final closed native hash are verified. Existing projects are never the SDK Save target. Native lossless import and general native relinking remain unproven. | [media relinking](MEDIA_RELINK.md), [saved derived proof](phase-0/media-relink-live-proof.json) |

The matrix does not describe arbitrary project compatibility, all timeline structures or automatic merge rules. Native processing parameters, general native field writes, cross-export FCPXML occurrence mapping, current unsaved identity, cross-device identity, media portability and exclusion of unrelated concurrent writers retain their existing limitations.

`src/personal-compatibility.js` recognizes only these exact personal profiles and the current observed host tuple. Its result is a read-only assessment: `safeToApply:false`, `executionAuthority:false`, `releaseSupported:false`. It never supplies an operation plan or bypasses the operation's existing identity, source, backup, preservation, publication, editor-validation or recovery guards. The older `compatibility-contract.js` remains the scanner's experimental read-only contract; it does not assess or authorize these later native operations. Runtime native guards still check the editor build and macOS platform independently; the catalog's current OS observation does not silently add an OS exclusion guarantee to those guards.

## Saved-project corpus

[The machine-readable catalog](phase-0/personal-compatibility-corpus.json) separates artifact types instead of treating exports as native restore points:

| Artifact | Provenance and coverage |
|---|---|
| Four editor exports | Untouched mixed-structure, 50-picture, 500-picture and 10,000-picture FCPXML exports from the one installed build. Both compressed and decompressed hashes, byte counts, exact frame counts and parser warnings are checked. Larger pre-existing exports are reused; no new scale fixture is generated. |
| Original B saved native checkpoint | 2,945,024 retained database bytes, independently bound to the controlled Name-preservation result and an authenticated actual open/readback/close restoration. The production census rereads every stored cell and schema object. The earlier failed SDK Save experiment is preserved as a failure; SDK Save preservation remains false. |
| Saved derived proxy review | Actual 50-picture moving-media review created, saved, reopened and closed by Resolve. Its three admission receipts, one-use tickets, exact executed Lua, signed final record, XML patch and closed native hash are reconstructed. The complete native census is freshly read from retained bytes. This is an editor-saved native project, even though its import is not a lossless representation of arbitrary source projects. |

The two native databases and their private signed authorities remain in the owner's ignored evidence retention. The public catalog contains synthetic project IDs, hashes, counts and repository-relative retention locations; it contains no raw database, media payload, original absolute media path or private key. A checkout without that private evidence cannot claim that the saved native corpus was reverified. The executable auditor fails rather than substituting exports or synthetic SQLite test databases.

The corpus covers the single declared personal editor build. It does not claim that every structure or operation within that build is supported, and it does not fill the deferred public-release version-corpus requirement. Expanding the personal set requires new editor-saved provenance, complete reader checks and an explicit operation matrix row; an empty or undeclared release range never counts as covered.

## Verification

```sh
node scripts/audit-personal-compatibility.cjs
node --test tests/personal-compatibility.test.js tests/personal-compatibility-evidence.test.js
```

The auditor authenticates retained records, reconstructs the exact program and admission/result bindings, verifies stored exports with the production parser, and stages fresh private copies of the two native databases for the production complete census. It removes only its disposable scratch directory. It does not read canonical editor databases, start Resolve, issue a ticket, recover a transaction, edit database bytes, repair permissions or grant Apply authority. The normal command also reobserves the current installed editor and host tuple.

After an intentional evidence/catalog change, the owner can rebuild the catalog with `node scripts/audit-personal-compatibility.cjs --write-catalog`. This command first reconstructs the retained facts, then writes the repository catalog and verifies it. It does not create or modify editor projects. Review the catalog diff and retain the public-release deferrals when doing so.
