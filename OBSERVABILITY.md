# Local operation health and reviewed diagnostics

Frameline keeps owner diagnostics on this Mac. There is no telemetry sender,
background export, remote dashboard, account identifier or pilot population in
this feature. The existing Diagnostics panel is the only export flow: review the
exact JSON and SHA-256, approve its contents, then choose a new output file.

The optional **Include session performance and operation health** checkbox
includes scan metrics and the following controller summaries:

| Workflow | What the summary describes |
| --- | --- |
| Native pull | Current retained plans, including pending editor validation, recovery, validated completion, validated rollback, cancellation and retirement |
| Media relink | Current retained relink/import intentions; a published XML or imported project remains pending until its corresponding verification completes |
| Asset transfers | Jobs visible in the current authenticated project selection, plus the count of retained unverified staging entries |
| Scan recovery | Retained scan intentions, including interrupted scans requiring explicit reselection and restart |
| Local integrity | The last observed check state and a closed failure category |

`statusCounts` are **current-state gauges**, not lifetime operation totals.
Switching the selected service project can change transfer counts. A domain with
`observed: false` has not emitted a state in this process; it does not mean the
workflow was checked and found healthy. An inventory beyond 10,000 rows is capped
and marked `truncated`. Error counts describe error fields in that current
snapshot, not distinct failure incidents. Editor-check status describes only the
currently selected check, when observed.

Native publication is not counted as validated success. Pending rollback
validation is not counted as a completed rollback. A safely retired intention is
reported separately from cancellation and from restoration. A failed action may
leave the prior retained intention unchanged; its current error category still
appears. No resolved JavaScript promise is treated as evidence of success.

Busy-period timing measures intervals between observed controller `busy: true`
and `busy: false` callbacks in this app process. These are **controller busy
periods, not individual operation latency or editor execution time**. Initializing
or inspecting a controller may create a busy period. Timing excludes an unfinished
busy period; it keeps at most 128 completed duration samples per workflow and
reports session counts, average, and recent p50/p95. These values reset when the
process exits. Reading the report does not advance timing or change its hash.
The existing scan metrics separately measure actual scanner calls.

Both console logs and reports use closed catalogs. Known events retain only
specified fields such as version, format, counts and known failure codes. Project
and revision IDs, paths, filenames, credentials, free messages and stacks are
excluded. Unknown event names become `unknown-event`; unknown errors, including
path-free opaque credential strings, become `unknown-error`. Regex-shaped text is
not sufficient to qualify as an error code. Adding a supported diagnostic code
requires a deliberate catalog change and privacy review. Console output is not
included in exported diagnostics.

Diagnostics schema 3 applies another independent projection to operation health.
Turning off session details omits both `adapterUsage` and `operationHealth`.
Changing an included health value after review invalidates approval before export;
changes to excluded health do not. Save cancellation retains the reviewed report.
The exporter writes reviewed bytes to a private temporary file and publishes
exclusively to a new destination; it never replaces an existing file or symlink.

Verification:

```sh
node --test tests/operation-health.test.js tests/logger.test.js tests/desktop-diagnostics.test.js tests/quality-release-foundations.test.js
node scripts/verify-observability-desktop.cjs
node --test tests/observability-desktop-evidence.test.js
```

The desktop proof uses two actual shipped Electron main/preload/renderer
processes, an actual worker scan, and the existing review/consent/export UI.
Native pull and relink lifecycle states are explicitly supplied callback fixtures
to test the observer wiring and pending-versus-verified distinction; this proof
makes no new SDK, publication, transfer or native field-preservation claim. The
receipt records exact runtime source hashes, source preservation, process restart,
review invalidation, private exact-byte export, and wide/narrow layout results.
Earlier native SDK evidence retains its original source provenance separately.
