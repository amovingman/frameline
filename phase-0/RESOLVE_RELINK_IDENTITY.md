# Resolve media relink identity proof

This is a disposable internal-Console experiment for DaVinci Resolve Free 21.1.2/build 21.1.20010 on macOS (API version 21.1.2.10). It is not a desktop relink feature or a production write adapter.

## Observed result

The new project `Frameline Relink Identity Proof` contains one timeline with three picture occurrences and two audio occurrences. Two picture occurrences share one media-pool item; the two audio occurrences share another. A separate picture source supplies the third media-pool item. The fixture uses copies of Frameline's sample JPEGs and a generated one-second silent WAV. No user media was relocated.

`MediaPool.RelinkClips` changed all three media-pool paths from a private original folder to another private folder containing byte-identical files. Every returned path was checked against its exact selected destination. The project was saved, closed and reopened; all three paths still matched the relocated folder. A reverse relink restored the original locations, followed by another save/close/reopen and path check.

Across the baseline, relocated, reopened and restored captures:

- All five occurrence IDs, the timeline ID, project ID and three media-pool IDs were retained, including the repeated-media groups.
- The complete represented observations were byte-identical: timeline fields, 110 returned property values across 39 keys, two track states and zero effects.
- Original and relocated file sizes and SHA-256 hashes matched before and after the experiment. Hashing took place in Node outside Resolve.

The reusable command generator and Lua spike were then exercised against the same fixture in both directions. Each run verified the exact observed source, all target media IDs and source paths, target-file presence, save/reopen, destination paths and exact resulting observation. It reacquires project and media objects after reopen. Result parts carry a unique capture ID and are validated for complete ordered transport, project identity, every media receipt and the full observation.

Resolve was returned to `Frameline Restore Probe`. Its captured state matched the previously verified richer observation exactly. The separate relink proof project was left saved with its original fixture media locations.

## Recompute the evidence

```sh
node phase-0/audit-relink-identity.js
node phase-0/audit-first-editor.js
node --test tests/resolve-relink-identity.test.js tests/first-editor-audit.test.js
```

`relink-identity-live-observation.json` binds seven path-free capture/receipt files in `resolve-xml-proof/`, plus the exact reusable Lua spike and command-builder source. The audit validates the observations and counts, compares every stage, checks the media hash receipts and native path receipts, and verifies both reusable-command results. Modified evidence or command sources fail verification. A successful audit reports only the scope demonstrated by this fixture; the broader track/export identity gates stay blocked.

The initial SDK `ImportMedia` dictionary form returned nil in this installed build. The path-list form worked. The first append batch returned five objects but yielded only four represented occurrences; a separate append established the fifth occurrence and actual track contents were recounted before the baseline. Returned API object counts alone are not evidence that a requested timeline layout was created. This experiment does not establish append/timing semantics.

## Repeat in a disposable project

Create a separate project named exactly `Frameline Relink Identity Proof`, with fixture media under an original folder and verified identical copies under a second folder. Include repeated picture and audio occurrences. Capture its complete observation with Frameline's normal read-only capture controls and **Save capture JSON**. Record each referenced media-pool ID with its actual filename, size and SHA-256 hash; filenames must be distinct within the chosen directories. The IDs from another project cannot be reused.

The developer API in `resolve-relink-identity.js` prepares a Console command after streaming and checking both folders. For example, from the repository root:

```js
const fs = require('node:fs/promises');
const { createRelinkIdentityCommand } = require('./phase-0/resolve-relink-identity');
const prepared = await createRelinkIdentityCommand({
  observationBytes: await fs.readFile(captureFile),
  media: mediaDescriptors, // [{mediaPoolId, name, size, sha256}, ...]
  sourceDirectory: originalFolder,
  targetDirectory: relocatedFolder
});
await fs.writeFile(privateCommandFile, prepared.command, {flag: 'wx', mode: 0o600});
```

Keep the returned descriptor locally. Paste its command into Resolve's Lua Console, run it, and copy the output. `readRelinkIdentityResult({captureId: prepared.captureId, output, observationBytes, media: prepared.media})` verifies the result. Retain the Console output on failure. To restore, prepare a fresh command using the verified resulting observation and reverse the source/target folders. Save and reopen again, recheck every path and file hash, and compare the original observation. The command includes private local directories; never include command text in a shared diagnostic report.

## Remaining limits

Media bytes are checked before command generation and after execution in Node. Resolve's execution-time guard checks paths and file presence, not content hashes. A same-path file replacement between those checks remains a gap. The Console capture ID prevents accidental mixing; copied output is not authenticated editor provenance. Commands have no durable retirement record and can run again if their exact expected observation and source paths are restored.

This fixture has no linked audio/video pair, effects, nested timeline, proxy or moving picture source. It does not prove persistent track IDs, API-to-export identity, full native field preservation, relinking arbitrary project structures, or application-level transactional recovery. The spike has no automatic rollback after an unexpected failure; use it only with a disposable project and retain the original fixture files. A production relink workflow still needs a trusted canonical media binding, execution-time content protection, verified backup and recovery, interruption handling and desktop integration. No mutation endpoint is exposed to the renderer.
