# Read-only native track identity graph

The exact installed Resolve SDK documents item/timeline/project unique IDs, but no persistent track-ID accessor. Native `.drp` exports expose a separate, undocumented explicit ID graph:

```
SM_Project.DbId                    API project ID
Sm2Timeline.DbId                   API timeline ID
  Sequence/Sm2Sequence.DbId        native sequence ID
    Sm2TiTrack.Sequence            reference to that sequence
    Sm2TiTrack.DbId                observed native track ID
      Items/Element/clip.DbId      API timeline-item ID
```

The diagnostic reads this graph without patching native bytes. A nonempty API track can be associated with the native parent of its exact item UUIDs only when every represented item agrees and both track counts and complete item-ID sets match. This is a source-bound **item-parentage witness**, not proof of persistent API track identity. Empty tracks remain unbound. Native vector order, display names and clip positions never select a persistent identity.

## Commands

```sh
python3 phase-0/resolve-native-track-identity.py graph /absolute/before.drp
python3 phase-0/resolve-native-track-identity.py bind-api /absolute/before.drp /absolute/snapshot.json
python3 phase-0/resolve-native-track-identity.py compare /absolute/before.drp /absolute/after.drp
```

The API input can be a schema-3 snapshot or a richer capture containing one. The existing JavaScript schema validator checks the complete snapshot before binding. Archives use the existing bounded, no-follow, no-extraction native reader. Duplicate IDs, inconsistent parent references, unknown item/track layouts, mismatched projects/timelines/items/counts, unsafe DTDs/entities and invalid snapshot schemas fail closed. Output contains opaque IDs, source/member hashes and bounded structural facts; native member filenames, user track names, paths and opaque field values are omitted.

Resolve's native XML-like files use C++ scoped names such as `ListMgt::LmVersionTable`, which ordinary XML parsers reject. The diagnostic remaps only colon-containing **element spellings** to distinct hashed names in an in-memory parser copy. Comments, CDATA and processing instructions stay untouched; DTD subsets and external entities are rejected. Original archive/member bytes and their hashes are never changed. This adaptation does not interpret or excuse any opaque native field and is not a writing schema.

## Controlled binding experiment

On a fresh, backed-up disposable project only, supported `SetTrackName` calls can challenge API track locations with unique temporary names:

```
Frameline-TrackProof-<same 32-hex nonce>-<video|audio|subtitle>-<API index>
```

Export and capture the challenged project, then use:

```sh
python3 phase-0/resolve-native-track-identity.py bind-challenge /absolute/challenged.drp /absolute/challenged-snapshot.json
```

Every track must have the exact same nonce and a name agreeing with its captured API type/index. Exactly one native track must carry each challenge hash, with identical item UUIDs and matching complete counts. This can identify empty tracks in that particular experiment. The challenge name is a temporary response binding, not a durable identity key. Ordinary binding and write-authority flags remain false.

Restore original names and verify before continuing. To test persistence, retain separate exports/captures around track rename, insertion/index shifts, save/reopen and restoration, then compare native UUIDs. A delete/recreate negative control must remove only a known empty track and demonstrate a fresh native UUID. Multiple empty/duplicate-name tracks are necessary to catch guessed mappings. General release support, API/export mapping, cross-device behavior and native field preservation remain separate gates.

## Guarded name/save/reopen drill

The separate write experiment in `prepare-native-track-challenge.js` accepts only `Frameline Integration Gate Fixture 20261120`, a complete richer observation of its 50 picture items on V1, and five through eight observed tracks including at least three video and two audio tracks. The selected baseline directory must contain `baseline.drp` and `observation.json`. Preparation fully verifies the native backup archive against the API project/timeline/item graph, copies it into a fresh private directory, and embeds the complete expected represented source plus unique challenge names in the issued source.

```sh
node phase-0/prepare-native-track-challenge.js prepare /absolute/private/baseline-directory --install
node phase-0/prepare-native-track-challenge.js read /absolute/private/preparation.json
```

Only the parent/operator invokes the returned Utility menu item. The script checks the exact project UUID/build, full richer source and backup size before changing any track name. It exports the before state, assigns the challenges, saves and closes/reopens, then captures/exports the challenged state. It restores original names, saves and closes/reopens again, requires exact represented restoration, exports the restored state, and publishes an exact-readback result plus completion marker. It does not patch native bytes, insert/delete tracks or move clips.

On a partial name-change failure it attempts restoration only when every represented field, after masking the specifically issued challenge names, still equals the bound baseline. An unrelated property/topology divergence stops automatic restoration and retains `recovery-required`. Host verification reconstructs the exact issued source, validates all richer observations and native archives, binds all challenge tracks including empty ones, and checks original native UUIDs/parentage/location and restored name hashes. Completed output prevents replay before editor writes. The existing verified backup and private exports are retained.

This is a separately authorized disposable research drill. It does not implement a general apply transaction, authenticate editor provenance, prove unrepresented native fields were preserved, or prove interrupted-runtime recovery. A process interruption may require manual recovery using the retained native backup. All ordinary apply and broad stable-track claims remain false even when the specific name/save/reopen drill passes.

The installed SDK documents only append-style `AddTrack(type, optionalSubtype)` and `DeleteTrack(type,index)` in the pinned reference, with no insertion-index argument. A controlled append followed by deleting a known empty earlier track can test an index shift without inventing an API overload. Separate exports/captures and fresh challenges are required around every operation.

## Existing evidence

The [historical observation](native-track-identity-historical-observation.json) recomputes four previously retained private archives. Both native track UUIDs persist through the earlier no-edit save/reopen control and the earlier isolated clip rename/save/reopen. All 53 captured API item UUIDs join to their explicit native parents. The source archive hashes match the existing native comparison reports. No fresh editor operation is claimed by that recomputation, and neither experiment renamed/reordered/deleted tracks or covered empty-track binding.

The exact native archives remain private. The public observation contains source hashes and derived facts; it cannot independently recreate native archives from hashes. `tests/resolve-native-track-identity.test.js` runs synthetic structural/adversarial tests, including duplicate names and empty tracks, controlled challenges, native ID retention across reordered vectors, entity/CDATA handling, path privacy and generic CLI failures. These tests establish the diagnostic's behavior, not a live track-identity guarantee.

## November 20 fresh native proofs

The backed-up `Frameline Integration Gate Fixture 20261120` supplied 50 picture items on V1 and five duplicate-name tracks, including four empty tracks. The [live name challenge](native-track-challenge-live-observation.json) bound all five API locations to explicit native track UUIDs and retained those UUIDs through supported name changes, save/close/reopen and exact represented restoration. Its untouched [compressed result](native-track-challenge-live-result.json.gz) retains four complete richer observations. Only the five track-name fields changed; captured item properties, effect metadata and track enabled/locked state did not change.

Three additional separately prepared native stages completed:

| Stage | Native identity result |
|---|---|
| [Append empty V4](native-track-topology-append-live-observation.json) | Added `9950ea6e-7c1c-4281-9c49-1beb75543769`, retained all five prior UUIDs, then challenged/restored six tracks. |
| [Delete known empty V2](native-track-topology-delete-live-observation.json) | Retired `ebccb2e6-6309-4750-bf8c-7012db202f10`. Controlled challenge bindings put retained `5690d038-9896-4252-83e1-1aab62c25289` at API V2 after V3, and retained `9950ea6e-7c1c-4281-9c49-1beb75543769` at API V3 after V4. |
| [Recreate known empty V3](native-track-topology-recreate-live-observation.json) | Retired `9950ea6e-7c1c-4281-9c49-1beb75543769`, created `d196e846-3ce4-4ece-af4a-98690db4ce0a`, and verified the fresh UUID was absent from all six earlier observed IDs, including retired ones. |

All 50 V1 item UUIDs and represented item/property/effect values survived. The final five-track API layout, duplicate labels and full richer observation equal the initial represented baseline. Native identity differences in the deliberately deleted/recreated empty tracks are expected; original native bytes or deleted native identities are not claimed restored. Native ordinals and duplicate labels did not select identities: every before/after API location was bound by a unique temporary challenge, and retained/retired objects were then compared by UUID.

The composite stage preparer chains from a verified earlier preparation:

```sh
node phase-0/prepare-native-track-topology.js prepare /absolute/previous/preparation.json append-empty-video --install
node phase-0/prepare-native-track-topology.js read /absolute/new/preparation.json
```

The later fixed operations are `delete-empty-video-2` and `recreate-empty-video-3`. The source guard binds the exact owned project, complete richer source and retained verified backup. Mutation code is restricted to those known-empty tracks and supported APIs; V1 cannot be selected for deletion. Every operation saves/reopens, exports its before/after native states, runs the full fresh name challenge, restores duplicate names and verifies represented state. Unexpected topology or partial failure retains its backup and stops; this is not a general recovery service.

`auditNativeTrackEvidence()` in [native-track-evidence-audit.js](native-track-evidence-audit.js) recomputes the name/save/reopen proof. `auditNativeTrackTopologyEvidence()` in [native-track-topology-evidence-audit.js](native-track-topology-evidence-audit.js) additionally verifies all six raw stage payloads, source receipts, full represented-state chain, controlled API/UUID bindings and retired-ID history. Both pin the public native graph facts and recompute their internal consistency. The original native archive bytes remain private; public consistency checks do not reconstruct those archives from hashes.

All four issued Utility scripts were verified by exact bytes/hash and removed after completion. Four complete private capture directories (62 files, 7,708,575 bytes) are retained durably under ignored `phase-0/private-integration-proof/track-identity`, with mode-0700 directories and mode-0600 files. Receipt SHA-256 is `2d24b1e1071ed21d2699ec66c3f07c98990d9d658ff931d8c103310c46360aff`. Original preparations keep their original absolute paths; copied commands and receipts do not authorize replay.

These proofs close the specific controlled name/save/reopen, index-shift and delete/recreate experiment gaps for this fixture. They do not establish a general synchronized read-only native/API mapping for empty tracks without challenge writes, broader construct/import/version behavior, full native preservation or ordinary Apply. The broad stable-ID roadmap gate therefore remains open.
