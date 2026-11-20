# Read-only Scripts-menu runtime probe

This disposable experiment checks a narrower question than ordinary editor integration: can a Lua script launched from Resolve's **Workspace → Scripts → Utility** menu read the currently named synthetic project and use Fusion IOClass to return a bounded result? It does not save, load, close, rename or otherwise mutate the editor project. It reads only the exact installed version, exact expected synthetic project name, project API ID, and timeline count, plus the availability of standard Lua I/O and Fusion file access.

The only accepted project is `Frameline Large Scan Proof 20261119 corpus01`, and the only accepted API version string is `21.1.2.10`. Another project or version fails before any output is written. No external scripting preference is changed. No render job or workflow integration is started.

## Preparation and installation

```sh
node phase-0/prepare-menu-runtime-probe.js prepare
node phase-0/prepare-menu-runtime-probe.js prepare --install
```

Each invocation creates a new mode-0700 directory under the host's temporary directory, a uniquely named mode-0600 Lua source, and a private `preparation.json` containing exact paths and hashes. The install form copies that exact source exclusively into the verified macOS user `Fusion/Scripts/Utility` directory. Existing files are never replaced. Installation is outside the repository's ordinary writable roots and may require sandbox approval. The installed source and preparation remain available for inspection; no automatic project action is scheduled.

The preparer checks the installed scripting reference against the existing pinned SDK SHA-256. Its record hashes the template, rendered source, reference and existing retained-result writer. The project getters and `Resolve.Fusion()` are documented in that SDK. Numeric `OpenFile` modes, `WriteLine` byte counts, `Flush`, void `Close`, and exact `ReadLine` behavior come from the independently recorded [Console writer probe](resolve-result-writer-live-observation.json) and `src/resolve-rename-trial.js`. They are hypotheses to recheck in the **menu runtime**, not previously established menu capabilities.

## Execution and verification

1. Keep the exact disposable project open and invoke the uniquely named Utility script once. Resolve may require a later script-menu rescan/restart before showing new files; avoid closing unsaved work merely to make the probe appear.
2. The script first refuses existing result or completion filenames. It writes a path-free JSON result through Fusion IOClass, flushes/closes it, then rereads and compares every byte. Only after that readback does it write its distinct completion marker. A repeated invocation refuses the existing output.
3. Verify the private record using the exact preparation filename returned by preparation:

```sh
node phase-0/prepare-menu-runtime-probe.js read /absolute/private/temporary/preparation.json
```

The reader requires the prepared source hash, matching probe ID, exact result schema, exact target project/version, bounded property values and matching completion marker. It refuses missing/partial/mismatched output, nonprivate containing directories, FIFOs and symbolic-link files. Fusion's output file mode is runtime-dependent; the reader tightens both owned outputs to mode 0600 through no-follow descriptors within the already-private directory before accepting them. It returns a path-free observation. Preparation itself is not a successful live editor run.

The Fusion IOClass API does not offer a proven exclusive-create mode. Its fresh private directory, unpredictable filenames and refusal checks prevent normal accidental overwrite or replay, but do not establish atomic exclusion against another process racing those exact filenames. This is a disposable local capability experiment, not a transport promoted to production.

## Verification scope

`node --test tests/resolve-menu-runtime-probe.test.js` executes the actual rendered source in the installed vendor Lua library against a mock Resolve API and virtual IOClass. It checks a successful read/write/readback, wrong-project rejection before output, replay refusal, source bindings, private preparation, and host rejection of incomplete or extra output. The mock has no editor connection; a passing mock does not prove menu execution, full project enumeration, track identity, lossless field preservation or editor-write support.

## Native menu observation

On November 20, 2026, the installed Utility script ran through the actual Scripts menu against the exact named disposable project. The [path-free observation](resolve-menu-runtime-live-observation.json) binds the [untouched result](resolve-menu-runtime-live-result.json), template, installed source, pinned API reference and known Console writer. The host verified its exact completion marker and result bytes. Resolve returned version `21.1.2.10`, project API ID `96752d7b-7fa0-4d51-aa56-80db8f18c5c6`, and three timelines. Standard Lua `io` remained unavailable; Fusion IOClass file access worked in this menu runtime.

Fusion initially created the output files as mode 0666 inside the already-private mode-0700 directory. The host tightened both outputs to mode 0600 and reverified the same result. The exact installed test script was hash-checked and removed after success; private preparation/results remain retained. This supersedes the older **file-handoff** blocker for this particular Fusion-based menu probe, while leaving complete content coverage, lossless preservation, persistent track identity, ordinary apply and release support unproven.

The host reader also requires current-user ownership and one hardlink before changing either output's mode; an unrelated linked file is rejected without changing its permissions. The prepared source must exactly match a reconstruction from the current template and bindings, as well as its recorded digest. These guards do not authenticate editor provenance against another process running as the same user.
