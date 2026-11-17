# Resolve Free internal companion prototype

DaVinci Resolve Free 21.1.2.10 did not accept the external Python scripting connection in the November 17 probe. The user chose to retain Free and test an internal script companion. The installed build exposes Lua in Workspace → Console. Its Scripts menu discovers `.lua` Utility files, but the menu runtime did not expose the expected file or system clipboard handoff. The desktop therefore uses a **read-only, manual Console handoff** for small disposable projects.

## Live result

On November 17, Frameline copied a five-minute, request-bound Lua command to the macOS clipboard. The command ran in Resolve's Lua Console against a new disposable project named `Frameline Lua Capture Fixture`. Copying the Console output back to the clipboard and selecting **Read copied result** in Frameline verified the request ID, request hash, expiry, project name, schema, and normalized snapshot. The live sequence progressed from an empty project to **one timeline and one audio item**. The saved timeline and item retained their API IDs; the item had exact frame positions and media-pool ID. Frameline saved the final verified capture as a local read-only observation revision on `main`.

The clip probe exposed a Lua binding detail: empty `GetEffects` lists include a `__flags` metadata entry. The companion now counts only positive integer list entries. A repeated live capture reported zero effects for the unmodified audio clip and passed the desktop validation loop.

The older ten-timeline performance project produced no usable Console output when the full snapshot was printed. The Lua command now refuses responses larger than 16 KB with a marked error. This is a limit of the experimental Console transfer, not a supported large-project capture path. It does not establish complete timeline coverage or a safe apply path.

## Desktop flow

1. Open a **small disposable project** in Resolve Free. Enter its exact name in Frameline's Resolve preview and choose **Copy capture command**.
2. Open Workspace → Console, select Lua, paste the command, and press Return. The command only reads the open project.
3. Click the Console output, press Cmd+A and Cmd+C, return to Frameline within five minutes, and choose **Read copied result**. Frameline extracts the marked result line from the copied output and validates it against its private request. The renderer receives only counts and a snapshot hash.
4. **Save snapshot JSON** writes a verified snapshot to a user-selected new file. **Save local revision** records the observation under the Resolve API project ID. The Local Resolve observations section can browse branches and parent differences after restart. A verified current capture can be used as the local side of a read-only three-way preview when its project ID matches and the selected base precedes the branch head.

The command and copied Console output contain display names and opaque IDs. They remain on this Mac. The private request stays in Frameline's user-data directory with restrictive permissions. The Lua source is copied to an immutable, hash-named private directory. No Resolve project is changed by capture, and neither an observation branch nor a matching project ID proves live edit provenance.

## Legacy Python fixture path

The original Python CLI prototype remains available for disposable fake-Resolve tests. Run `node phase-0/companion-capture.js prepare PRIVATE_DIRECTORY "Exact Resolve Project Name"`, execute its Python command inside a compatible Resolve Python Console, then run `node phase-0/companion-capture.js read PRIVATE_DIRECTORY REQUEST_ID REQUEST_SHA256`. This path is not verified in the installed Free build.

Automated tests cover request binding, private script installation, the Python fixture writer, Lua command generation, and copied-result validation. The live check covers one audio item on one timeline; it does not prove video, effects, transitions, linked items, or larger project coverage. Complete read coverage, stable export mapping, large-project transfer, and recoverable write transactions remain open.
