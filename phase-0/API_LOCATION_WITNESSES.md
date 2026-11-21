# Independent populated-track location witnesses

The exact installed primary SDK declares `TimelineItem.GetTrackTypeAndIndex()` as a two-element list of track type and index. `TimelineItem.GetPosition(false)` returns a `TimelineItemPosition` dictionary containing optional `trackType`, `trackIndex` and `startFrame` fields; its `trackIndex` is documented as one-based. The vendor's `Examples/5_get_project_information.py` similarly enumerates each track type from 1 through `GetTrackCount(type)`. The installed 21.1.2 changelog identifies position editing and `Timeline.MoveItems` as current additions.

The SDK declares project, timeline and timeline-item unique IDs, but no track object class or persistent track-ID accessor. The installed README, changelog and examples provide no contract relating native archive vector order to API track indexes. Native vector position can therefore be a separately tested location rule, never the identity itself. Native `Sm2TiTrack.DbId` remains the candidate identity. Native archive inspection found no separate textual track-index field in the retained fixture's track records; opaque blobs were not interpreted.

Primary local source hashes:

| Installed source | SHA-256 |
|---|---|
| `DaVinciResolveScript.pyi` | `2a6c156fcba727b73e16fdc21b90e77db9b914c08c5bf5b53b584380a972f8d7` |
| `README.md` | `a4ee8a88a90b51b624646d6e565682083264d05f39b16cbf20630f12c7da0593` |
| `CHANGELOG.md` | `fd64134e7c7c8ee638c6bccc144c9cd9297042c312c20542757734dba6920673` |

These files are installed beneath `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/`. The README states that Free and Studio share an API superset and calls may return failure when unavailable in Free. A declaration does not establish native availability.

## Embeddable read-only supplement

`src/companion/resolve-api-locations.lua` exports:

```lua
location.capture(resolve, base, effects, property_config, max_items)
```

`base` and `effects` are the existing schema-3 and richer-observation modules. The result contains its complete schema-2 `richContext`, active timeline/page, typed runtime witnesses from `GetVersionString`, `GetProductName` and `IsStudio`, and one record for every item in the rich snapshot. Each item record contains its timeline/item UUID namespace, the current `GetItemListInTrack` enumeration location, and independent typed reads from both location methods. Calls use `GetPosition(false)` explicitly; returned frame values preserve 17-significant-digit decimal text. This does not establish audio subframe semantics.

Both full witness reads must match. Rich captures, runtime metadata, page and active timeline must remain equal before and after the reads. Bounds are 200 items, 20 timelines and 200 tracks; the complete project is counted before expensive richer capture. No timeline selection, page switch, project save/load, or mutation method is called.

Nil, false or thrown location reads become unavailable. `IsStudio: false` is a captured boolean, not an unavailable read. An empty or partial position dictionary stays empty or partial; omitted keys have no defaults. Unknown keys, malformed list shapes and invalid types reject capture. The list-return shape follows the installed SDK; an unexpected native multiple-return shape must be investigated rather than guessed into a successful witness.

`src/resolve-api-location-observation.js` exports validation/parsing, `assessApiLocationWitnesses(observation)` and `requireApiLocationWitnesses(bytes)`. Required acceptance demands populated video and audio items, both getters' complete location fields agreeing with enumeration, captured rich property/track reads, a known page and explicit native Free product/build witnesses: product `DaVinci Resolve`, version `21.1.2.10` and captured `IsStudio: false`. Missing Free/Studio evidence cannot be inferred from a version string. GetPosition's optional `startFrame` is retained without using it as an item or track identity key.

This supplement checks current locations of populated tracks. It does not identify empty tracks or persistent track UUIDs. `tests/resolve-api-location-observation.test.js` uses the regular-file-descriptor vendor-Lua mock helper and covers repeated media, both populated kinds, unavailable/partial getters, mismatched locations, unknown fields, context changes, bounds and fail-closed acceptance.

## Held-out native proof

A practical personal-build proof can freeze read-only UUID/location predictions on a fresh project before applying any challenge names. Independent supported name challenges can then confirm every prediction, including multiple identical empty tracks. Repeat that prediction-before-challenge ordering around rename/save/reopen, a cross-track clip move that changes membership, earlier-track deletion/index shifts, and same-index recreation with a fresh UUID. A second graph must not inherit the first calibrated graph's UUID ledger or lookup results. Source-bound read/export/read captures, complete namespace/item sets, fresh archive hashes and late API-location checks must reject drift.

That empirical exact-build location rule can support a defined flat video/audio direct-API identity capability once actual held-out tests pass. It remains undocumented native serialization, does not make vector position a stable identity, and does not establish FCPXML occurrence mapping, full native preservation or ordinary Apply authority.

The completed [saved-checkpoint proof](RESOLVE_NATIVE_IDENTITY_PROFILE.md) additionally requires source-verified save/close/reopen provenance for native empty-track UUID binding. Intermediate unsaved exports retained the earlier saved UUID graph; populated API location witnesses alone cannot detect an empty-track deletion/recreation with unchanged shape. The supported native reader therefore does not bind current unsaved state.
