# Media availability and storage policy foundation

`src/media-storage-policy.js` adds the next five Phase 4 policy behaviors to the local reference service. The outputs contain IDs, states, classes, hashes, and byte counts; they do not expose local paths.

- Availability uses explicit evidence to distinguish `cloud-present`, `collaborator-only`, `local-only`, `missing`, `excluded`, and `archived`. A cloud-present asset can also have a verified local copy; both facts remain visible.
- Per-project sync policy starts with no asset classes enabled. A project-authorized caller can select from original, proxy, audio, graphics, and other. The policy has a serializable snapshot; durable hosted configuration and a desktop control remain open.
- A revision download plan includes only required assets. Execution resolves the authoritative selected revision again, rejects added or changed assets, rechecks any claimed local asset, reads only planned cloud chunks, verifies each chunk and the final SHA-256, and writes content-hash-named files without overwriting existing files. The caller must choose a destination and supply the authoritative revision reader. A hosted revision/media manifest binding remains open.
- Relink candidate checks require both the expected asset class and exact size and SHA-256. A proxy cannot satisfy a camera original even if it has the same name or bytes. This produces a decision report; editor project reference rewriting remains unavailable.
- Upload estimates report bytes to upload, bytes reused within the configured storage namespace, bytes excluded by class policy, and current project logical and exclusive storage. The service reports stored usage from verified asset records. Estimates are not billing quotes and do not include transfer overhead or retention charges.

The desktop app still has no hosted cloud connection or media-transfer UI. These behaviors are tested local foundations; the Phase 4 product checkboxes remain open until they are integrated with canonical revision metadata, hosted storage, and the user interface.
