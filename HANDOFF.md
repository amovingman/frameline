# Work handoff — 2026-11-09

## Current state

Work is on `codex/revision-backups`. The local commits through `009a683` add a read-only FCPXML revision workflow, synthetic compatibility corpus, conservative API/export matching experiment, parent-revision sequence/media inventory comparison, verified relink for a moved export, explicit adapter capability refusals, version gating, and local history graph validation. The handoff commit strengthens the Resolve snapshot probe against duplicate IDs. See `ROADMAP.md` for checked items and `phase-0/INTEGRATION_ASSESSMENT.md` for the integration evidence.

The app can scan a supported FCPXML 1.10 picture sequence, save immutable local scan revisions and branches, inspect a saved parent comparison, export/import revision backups, and relink a moved export when its bytes match a verified saved branch head. It does **not** apply a revision to Resolve, claim clip identity from FCPXML, or offer a safe pull/merge. The initial editor, edition, and version range remain provisional.

## Verification

- `npm test` — 49 passing at the last full run.
- `python3 -m unittest discover -s phase-0/resolve-xml-proof -p 'test_*.py' -q` — 19 passing after the latest probe and matcher changes.
- Live Electron UI: saved two local revisions, viewed the parent comparison, moved an identical export to a new path, relinked it, and saw the two revisions restored. This used temporary FCPXML files and left test-only history in the app's local userData.
- Synthetic scan benchmark: 1k–10k clips, recorded in `phase-0/SCAN_BENCHMARK.md`. It does not establish real-project write/reopen performance.

## Resume in this order

1. **Capture a live schema-3 Resolve API snapshot** from the existing disposable `Frameline API Relink Test` project in Free 21.1.2. `phase-0/resolve-xml-proof/README.md` has internal-console commands. Use a new `/private/tmp/...json` path because `capture_to` refuses overwrite. Inspect track names/types, linked IDs, and effect counts. The UI automation opened Workspace → Console, but the console did not appear in its accessible main window, so no schema-3 live capture was made. Do not treat mock tests as live evidence.
2. Repeat capture before/after an edit on **copies** and evaluate `api_export_mapping.py`. Keep its `safe_to_apply: false` result; timing matches do not establish persistent API ↔ FCPXML identity. Resolve's FCPXML exports omit API item IDs.
3. Build editor-backed fixtures with moving video, linked audio, multiple tracks, transitions, effects, and nested sequences. Record what the API and FCPXML each enumerate and where the scanner warns or refuses. Obtain representative projects and editor/version needs from intended users before declaring support.
4. Measure scan, write-to-copy, and reopen on a realistically sized project. Design an apply transaction only after identity, backup, validation, and recovery gates have evidence.
5. Re-run the matrix in Studio and in any proposed supported version range. External API integration for the desktop app is still unproven.

## Repository and delivery notes

The working tree should be clean after the handoff commit. The user subsequently approved publishing to GitHub. Shell HTTPS push had no credential, so the GitHub connection is being used to publish the branch as one consolidated remote commit. Verify the remote tree and branch head after publication. No merge into `main` has been requested.
