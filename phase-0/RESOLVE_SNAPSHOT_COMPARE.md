# Read-only Resolve API snapshot comparison

For the initial DaVinci Resolve **Free 21.1.2.10** target, capture schema-3 JSON from a disposable named Frameline project through Resolve's internal console as described in [the API proof](resolve-xml-proof/README.md). Compare two captures from the same project:

```sh
node phase-0/compare-free-snapshots.js phase-0/resolve-xml-proof/live-mapping-before-schema3.json phase-0/resolve-xml-proof/live-mapping-after-schema3.json
```

The command validates the exact schema and Free build, normalizes timelines and items, compares retained item IDs, and groups changes by item. It reports source hashes so a comparison can be repeated against the same files. The paired live captures show one retained item moving from frames 457–554 to 600–697; its duration stays 97 frames. File paths are excluded from the report and errors.

API item IDs support a read-only comparison within the same Resolve project. Track names and type/index positions are **not** proven stable track IDs. FCPXML exports omit API item IDs, and this tool does not map an API item to an XML clip. It does not write to Resolve, the project, or the snapshots. `safeToApply` remains `false`; the app's FCPXML revision manifest and pull controls remain unchanged.
