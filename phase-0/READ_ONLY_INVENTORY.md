# Free Resolve FCPXML inventory

The read-only diagnostic inventories serialized structure in named Frameline FCPXML 1.10 exports from the initial Resolve Free 21.1.2 target:

```sh
node phase-0/inspect-free-export.js phase-0/compatibility-corpus/resolve-structure-live.fcpxmld
```

It reports sequences, gap containers and lane entries, explicit audio items and candidate same-clip associations, transitions, and serialized filters or adjustments. The result includes an XML SHA-256 for repeatability. Source media paths, effect UIDs, and parameter values are excluded. The diagnostic accepts one named Frameline project per export and reads at most 20 MB. It does not modify the export or the Resolve project.

The live structure fixture yields one sequence, one serialized gap, three picture entries, one explicit audio entry, two entries whose type remains unknown (transition and compound reference), one Cross Dissolve with serialized duration `1/12s` (two frames at 24 fps), and five serialized filter/adjustment nodes. The internal Resolve API observed an OFX Transform that was absent from this XML. Therefore a missing serialized filter does not mean the editor effect is absent.

FCPXML lanes are not Resolve track numbers. Connected lane offsets are retained as serialized because their sequence coordinate rules are not yet proven. Same-clip audio associations are candidates, not stable links; asset `hasAudio` metadata alone does not create a timeline audio item. These inventories are separate from the app's strict v2 scan manifest and do not authorize clip matching, comparison, apply, or pull.

## API/export coverage check

Run the separate coverage check against the paired API observation and untouched Free export:

```sh
node phase-0/reconcile-free-coverage.js phase-0/compatibility-corpus/live-structure-api.json phase-0/compatibility-corpus/resolve-structure-live.fcpxmld
```

The count report observes four API video items versus three XML picture entries plus one compound reference whose type is unresolved in XML; one transition on each side; and **two API audio items versus one explicit XML audio entry**. The API reports two items with linked partners and one OFX occurrence, while the XML report has no candidate link and cannot assess effects absent from XML. Counts agreeing do not establish object identity. The report always sets `completeEnumeration` and `safeToApply` to `false`, omits API IDs and media paths, and keeps FCPXML lane numbers separate from API track numbers.

## Normalized snapshot coverage matrix

`coverage-free-snapshot.js` compares a validated schema-3 snapshot with an FCPXML export at aggregate level:

```sh
node phase-0/coverage-free-snapshot.js snapshot.json timeline.fcpxmld
```

When either source has multiple timelines or sequences, pass the API timeline ID and XML `sequence-N` ID explicitly. The report includes exact SHA-256 hashes of both input files, counts for video, audio, transitions, links, effects, and occupied lanes, and lists omitted or unobservable constructs. A selected pair is only a comparison scope; it does not authenticate that the observations describe the same timeline. API IDs are never matched to XML entries, XML lanes are never treated as Resolve tracks, and `completeEnumeration` and `safeToApply` remain false.
