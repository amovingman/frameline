# Synthetic FCPXML compatibility corpus

These fixtures were written for Frameline and contain no project or media files from a user. Keep each XML source unchanged after adding it; add a new fixture for a new editor export or behavior. The companion `expected.json` records the read-only v2 scan's observable sequence, clips, media, and warnings. The test checks the source hash separately and validates the full manifest schema.

`basic-edits.fcpxml` covers ordered picture clips, a trim, a move, a gap, and repeated use of one asset. `edit-before.fcpxml` and `edit-after.fcpxml` form a synthetic insertion/deletion pair with a shifted surviving clip. `unsupported-structures.fcpxml` covers a transition, connected audio, an effect, and a nested clip. The expected result deliberately excludes unsupported content and warns about it. These synthetic files are parser coverage, **not** proof that Resolve imports, preserves, or safely writes these structures.

The corpus still needs untouched Resolve exports for moving footage, multiple tracks, transitions, effects, linked audio, and nested sequences, plus fixtures from each declared supported version. No version range is declared yet.
