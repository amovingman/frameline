# Local metadata safety

Frameline stores its own metadata in Electron's user data directory. It does not edit the selected FCPXML export. Version 1 contains only a map from SHA-256 fingerprints of absolute project paths to randomly generated local project IDs. No project paths or media paths are stored in this file or sent to the renderer.

`metadata.json` is written through a temporary file and rename. `metadata.json.bak` holds the prior valid state, or the first state after initial creation. If the primary file is damaged, Frameline preserves it as `metadata.json.corrupt-<id>`, restores the backup, and reports recovery. If neither copy is valid, it stops metadata writes and shows an error. A file with a newer schema version is never rewritten by an older app.

Future metadata changes must increment `schemaVersion` and migrate a validated copy before replacing the primary file. Tests must cover upgrade, interrupted write, backup restore, and refusal to downgrade. A project moved to a new path currently receives a new local ID; moving and relinking IDs requires a separate workflow before revisions are durable.
