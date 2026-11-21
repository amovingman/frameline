# Run Frameline from source

The shortest route is the local fixture demo. You can scan a synthetic timeline, save revisions, and inspect history without a Resolve installation, cloud account, or media download.

## Requirements

- **Node.js 24 and npm.** The repository's CI uses Node 24. The owner's latest checks used Node 24.21.0 and npm 11.19.0. Use the committed `package-lock.json` through `npm ci`.
- **A desktop session** to open Electron. The native editor work was tested on macOS; Linux CI exercises the JavaScript tests. Windows desktop and editor support have not been established.
- **Xcode Command Line Tools on macOS** for the normal `npm start` command. Its prestart step compiles the Swift media helper if it is missing or older than its source. The helper targets macOS 13 or later. This build target does not establish editor compatibility across those OS versions.

Native Resolve experiments also use `python3` and the exact tested editor build. They are separate from the fixture demo.

## Run the terminal demo

After installing Node.js 24, run these commands from the repository directory:

```sh
npm ci
npm run demo
```

This uses the real scanner and history store in a temporary workspace, prints the comparison, then removes its demo files. It needs no graphical session, Swift tools, Python, or editor. [The demo guide](DEMO.md) explains the output and retained-workspace mode.

## Install and open

From the repository directory:

```sh
node --version
npm --version
npm ci
npm start
```

`npm ci` downloads the locked dependencies, including Electron. It needs network access on the first install. `npm start` opens the desktop app; it does not start a server or sign in to a service.

On a Mac without the Swift tools, you can open the basic scan and history interface directly after installing dependencies:

```sh
npm exec -- electron .
```

That command skips the media-helper build. Leave thumbnail, proxy, and storyboard generation off until you have built the helper. To enable those features later, install Xcode Command Line Tools and run:

```sh
npm run build:media
```

## Open a fixture

1. In first-run setup, keep app storage or choose a folder for revision history. A chosen folder receives a `Frameline revisions` subfolder.
2. Choose **Choose project**, then select `phase-0/compatibility-corpus/basic-edits.fcpxml` from this checkout. If setup is already complete, use **Choose file**.
3. Inspect the scanned sequence and media inventory. The fixture's media paths may be missing on your machine; scanning the XML does not require those files.
4. Save a revision with a message, then open **History** to inspect it. Follow [the demo guide](DEMO.md) for a fuller walkthrough.

The opening **Sample workspace** is an interface example. Selecting an FCPXML file starts a real read-only scan. Neither flow authorizes editor writes.

Revision records go into the chosen workspace. Settings, credentials, queues, and other app state use Electron's local app profile. The source export and media stay where they are. Storage selection is fixed once a project opens; this interface does not move an existing workspace. [Workspace setup](WORKSPACE_SETUP_AND_DIAGNOSTICS.md) explains storage recovery and reviewed diagnostics.

## Check the code without an editor

These focused checks use checked-in fixtures and disposable local state:

```sh
npm run test:fixtures
npm run test:demo
node --test tests/local-metadata.test.js
npm run test:comparison-review
```

They cover XML scanning, immutable history and branch records, damaged metadata recovery, exact frame values, conflict context, and source-bound review decisions. They do not open Resolve or need a cloud account.

For the wider automated suite:

```sh
npm test
```

The wider suite requires `python3` for synthetic native-database tests. Some suites launch child processes, create loopback HTTP/HTTPS services, or use macOS tools. Allow local loopback connections in your test environment. Tests report explicit skips when their private evidence, installed Resolve API/Lua runtime, or macOS file-attribute profile is unavailable. Portable JavaScript, synthetic database, and HTTPS checks still run. Passing the available tests does not reproduce a live editor observation.

The [CI workflow](.github/workflows/ci.yml) also runs migration, security, dependency, and package-input checks. On macOS, the package check builds both native-helper architectures and requires the Swift tools:

```sh
npm run package:check
```

This checks package contents; it does not create a signed installer.

## Native editor work and retained evidence

The recorded editor target is **DaVinci Resolve Free 21.1.2, build 21.1.20010, on macOS**. The scanner accepts **FCPXML 1.10**. The current owner machine was observed as macOS 15.6.1, build 24G90, arm64; earlier proofs did not all record an OS patch. See [personal compatibility](PERSONAL_COMPATIBILITY.md) for the exact profiles.

Native Apply has a narrow demonstrated profile: changing one existing video clip's Name in a closed local disk project, with identity checks, backup, field preservation checks, reopen validation, and recovery. The fixture walkthrough does not use that writer. General timeline edits and arbitrary Resolve builds have no support claim.

Public proof receipts describe the native experiments. Their raw databases, private signing keys, and machine-bound journals remain outside Git. Commands such as `audit:native-pull-live`, `audit:native-result-live`, `audit:media-relink-live`, and `audit:personal-compatibility` need that retained evidence and, for current-source checks, the matching local editor environment. They are owner verification tools rather than fresh-checkout setup steps.

## If something fails

| Symptom | Next step |
| --- | --- |
| `npm ci` fails while downloading Electron | Check network access and npm's reported error, then rerun `npm ci`. |
| `npm start` reports `native-media-build-failed` or an `xcrun` error | Install or repair Xcode Command Line Tools, or use the direct Electron command above for scanning and history. |
| Electron cannot open a window | Run it in a graphical desktop session. A headless test runner is enough for the focused Node checks. |
| A fixture lists missing media | Continue with XML scanning and revision history. The fixtures do not bundle camera footage. |
| The selected revision workspace is unavailable | Reconnect the original folder at its saved location. Frameline preserves the binding rather than silently creating empty history elsewhere. |
| A native audit reports missing retained evidence | Read its public receipt and use the public tests; that audit cannot be reproduced from Git alone. |

The optional self-hosted service has its own [setup guide](SERVICE_HOST.md). It is unnecessary for the local portfolio demo.

## Optional S3 backups

The [cloud backup guide](CLOUD_BACKUP.md) covers manual upload, listing, and verified download of exported revision bundles. It uses your AWS profile and a private bucket; no Frameline service is needed. Try the production backup code with simulated storage first:

```sh
npm run demo:cloud-backup
```

`npm run test:cloud-backup` also exercises the real AWS SDK against a local HTTPS protocol fixture. These tests need loopback networking, with no cloud account or credentials.
