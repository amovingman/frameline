# Relink originals and proxies into a reviewed copy

Frameline’s Media panel can relocate declared original and proxy references in a new regular FCPXML 1.10 copy. It fingerprints each role before files move, verifies replacement size and SHA-256, and patches only the selected `src` attribute values. Repeated aliases stay consistent; comments, metadata, formatting, and every other XML byte remain unchanged. The source XML and media files are read only. Publication creates a new file exclusively and refuses an existing destination.

This owner workflow supports the declared flat picture subset, local regular files, explicit original/proxy roles, and exact media identity captured while files are available. Missing fingerprints, ambiguous resource IDs or role aliases, unsupported structure, stale files, replaced destinations, and incomplete evidence block publication. A proxy cannot be selected as an original merely because its filename matches. This feature does not reconstruct missing identity or relink an existing native project.

## Use the Media panel

1. Select and scan the source FCPXML; capture its media references while originals and proxies are available.
2. After moving media, choose each replacement under its original or proxy role. Review the expected byte size, content hash, and alias count.
3. Prepare a new copy destination. Check the acknowledgment for that exact reviewed plan and create the copy. A restarted app restores the review but clears consent and never publishes automatically.
4. Optionally prepare **Check in Resolve**. This creates a unique one-use Utility command for a **new derived review project** in the selected local disk library.
5. In Resolve Free 21.1.2, initialize an empty, unsaved **Untitled Project** workspace at that library’s root, with no timeline or media. The startup Project Manager cannot execute Utility commands. Close saved projects first; the host independently refuses creation while any native Project.db is open.
6. Run the displayed Utility command and use **Read import check** in Frameline while it waits. Three authenticated host admissions bind the empty workspace and the actual open new project before import and after save/reopen.
7. After the command reports completion and closes its new project, quit Resolve and use **Validate imported copy**. Frameline checks the exact closed database hash, project identity, installed build, permissions/access boundary, and two process/open-file observations without changing the database.

The command imports only into its new generated project, explicitly links its proxy media, and verifies represented original/proxy paths, occurrence IDs, offsets, source in-points, and durations before and after save/reopen. Immediate current-project checks guard SDK saves, closes, and loads. SDK Save is permitted only for this newly created derived representation. **This does not prove lossless native import or authorize SDK Save on an existing project.**

## Interruptions and retention

A prepared unused command is reused with the same token. Started, failed, and completed commands cannot obtain a fresh token automatically. Passive startup and recovery issue no host tickets or SDK effects. If a host dies after retaining an admission but before its ticket, an explicit read can restore that exact missing ticket after fresh matching observations.

Quit Resolve before explicitly retiring an interrupted import. Retirement first writes a durable revocation marker, then removes only the exact owned installed Utility command. Any partial or corrupt new native output stays retained as **unverified**; it is never deleted, repaired, chmodded, or promoted to a successful proof. A fresh attempt uses a different token, generated project name, and target path. Native output and private evidence may be inspected and removed manually after review. An interruption while installing a command before the intent records it can leave an untracked Utility script; its host admission cannot be issued, so it cannot create a project.

Resolve creates this new native output with mode0666. Historical closed verification accepts that observed creation mode only behind an authenticated owner-private access boundary. It does not grant native write/Apply authority. Known SDK result files inside the private attempt directory are normalized to0600 through stable no-follow descriptors; source XML, media, configuration, and native Project.db are never chmodded.

## Evidence and checks

The live proof used Resolve Free 21.1.2 build21.1.20010 on macOS, moving MJPEG originals/proxies, 50 picture occurrences, two distinct media roles, three changed XML attributes, three host admissions, actual SDK save/reopen, and a closed database matching the final open-file admission. The protected existing native project remained byte-identical. This is an owner-only installed-build observation, not Studio, cross-device portability, general native relinking, or concurrent-writer exclusion proof.

`phase-0/media-relink-live-proof.json` contains redacted hashes and source pins. Owner-private retained journals, receipts, media, and database copies are excluded from Git. `node scripts/audit-media-relink.cjs` reconstructs the authenticated plan, exact byte patch, admission receipt digests/tickets, 50 represented rows, closed proof, native identity, and fresh unchanged source/media/native hashes. It executes no Resolve command and does not require the historical library to stay active.

`npm run verify:media-relink` runs the shipped main/preload/renderer in two real Electron processes, including restart, role rejection, consent, exclusive publication, text-safe names, and1440/600px layouts. Screenshots and machine checks are in `phase-0/media-relink-desktop/`. Unit and vendor-Lua tests cover interrupted publication/admissions, one-use replay refusal, switched current projects, private JSON paths/errors, SDK-created output modes, stale bindings, and read-only closed validation refusals.
