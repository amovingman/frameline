# Guarded operation measurements

This experiment measures an existing, separately prepared disposable rename trial. It does not create a new editor write path or modify the trial generator. The backup or issued command is embedded unchanged, with its exact SHA-256 retained. Narrow proxies time the underlying item rename and project-manager save, export, close and load calls. Source guards, backup verification, retained-result replay barriers, supported mutation methods and represented-state validation remain those of the original trial.

Preparation requires a private existing trial, one represented clip-name change, no more than 50 represented items, and a schema-2 effect/property/track supplement with no unavailable reads. Issued experiments also require a verified native backup and the existing retained-file outcome transport. Inputs and resulting reports stay local. Timing reports alone never acknowledge or validate the editor result.

## Clock capability

`resolve-operation-clock.lua` first tries a real POSIX monotonic wall clock through built-in LuaJIT FFI. The installed macOS SDK documents `CLOCK_MONOTONIC = 6`, `clock_gettime`, `clock_getres` and the two-long `timespec` ABI on this 64-bit target. The actual vendor Lua library can call that clock in a mock process. That does not prove FFI access in the menu runtime.

The separate read-only `prepare-operation-clock-probe.js` checks the actual menu runtime against the exact named `Frameline Integration Gate Fixture 20261120` project. It changes no project data. The verified November 20 menu run used the fallback `os.time`: actual wall-clock timestamps, **one-second resolution and nonmonotonic**. The monotonic FFI clock was unavailable there. CPU uses `os.clock` independently and may include work by other editor threads. Reported resolution or an observed minimum step is not a clock-accuracy guarantee.

For the coarse wall clock, the host reader reports a quantization window for each operation and the total. A zero-tick difference means a duration within **[0, 1 second)** under the explicit assumption of no realtime-clock adjustment; it never means a zero-duration API call. A two-tick difference yields **[1, 3 seconds)** under the same assumption. Regressing or missing readings remain unavailable. No high-resolution wall-clock result is inferred from CPU time.

## Execute an already prepared trial

Save the exact object returned by the existing `prepareReviewedRenameTrial` to a private JSON file, then prepare its backup timing wrapper:

```sh
node phase-0/prepare-timed-guarded-command.js prepare /absolute/private/backup-command.json /absolute/private/trial-directory backup --install
```

Invoke the returned uniquely named Utility script once. Verify its private result:

```sh
node phase-0/prepare-timed-guarded-command.js read /absolute/private/timing-directory/preparation.json
```

The ordinary host trial code must independently verify the native backup before issuing the actual rename command. Save the exact `issueRenameTrial({ resultTransport: 'retained-file', ... })` return object privately, then prepare the issued wrapper with stage `issued`. The actual experiment mode and forced-rollback flag remain those of that existing issuance; instrumentation cannot switch modes.

The wrapper writes a fresh session marker and a start marker before each timed API call. If the menu runtime terminates during close/reopen, missing completion stays incomplete; no duration or successful outcome is invented. Complete timing results require exact writer readback and a separate nonce-bound completion marker. Reads verify source reconstruction, original emitted command/plan bytes, operation fields, event starts and owned singly linked private outputs. Hardlinks and symbolic links cannot cause an unrelated file to be chmodded by the reader.

After the issued command, verify the existing retained trial outcome with `recordRenameTrialFileResult` separately. A timing report with `commandReturnedNormally: true` only says that the guarded command returned to instrumentation. The command can have completed a forced rollback or recorded recovery-required; its independent outcome remains authoritative. A rejected stale source can produce a timing report with no rename calls and no successful trial outcome.

## Verification scope

`tests/resolve-operation-clock.test.js` runs the actual clock and probe sources in the vendor Lua library, including missing-FFI fallback, regressions, file handoff and host hardlink/privacy checks. `tests/resolve-timed-guarded-command.test.js` executes the actual existing guarded command inside the timing wrapper against the saved-state fake editor. It covers normal applied outcome, intentional rollback, source divergence, exact save/export behavior, retained outcome verification, replay refusal, and coarse quantization windows. These mocks establish instrumentation behavior; native measurements and preservation proof require the separately retained actual menu results.

Complete field/native preservation, persistent track identity, general apply, and power-loss durability remain unproven. This experiment measures only the explicit small disposable operation and its represented checks.

## November 20 native measurements

The actual 50-item fixture completed the [guarded backup](resolve-operation-backup-live-observation.json) and [forced rename/rollback](resolve-operation-rename-live-observation.json) through the Utility menu. The native backup was independently verified at 53,560 bytes, SHA-256 `c957154992c3dea267c590759ac273ae2f18c4a717bcc26fae58bf5522a31026`. Its archive remains private. The trial's existing retained-file reader independently acknowledged **rolled-back** after both save/close/load cycles. All 50 occurrence IDs, 1,600 returned property values, five indexed track states and represented effect metadata matched the exact original observation bytes. This does not compare unrepresented native fields.

| Underlying call | Process CPU microseconds | Wall-clock ticks |
|---|---:|---:|
| Backup save | 201,463 | 0 |
| Native project export | 179,629 | 1 |
| Forward rename | 5,750 | 0 |
| Forward save | 204,971 | 0 |
| Forward close | 176,571 | 1 |
| Forward load | 431,302 | 1 |
| Reverse rename | 936 | 0 |
| Reverse save | 123,340 | 0 |
| Reverse close | 110,343 | 0 |
| Reverse load | 390,644 | 1 |

The backup command total sampled 730,370 CPU microseconds and one wall tick. The issued rename/rollback command total sampled 2,349,874 CPU microseconds and three wall ticks. Under the stated no-clock-adjustment assumption, the issued command's wall quantization window is **[2, 4 seconds)**. Each zero-tick call is **[0, 1 second)** under that same assumption. Total includes the existing source guards and verification captures; it is not the sum of native call CPU samples. CPU may include other editor threads.

The [RSS report](resolve-operation-rename-rss.json) sampled the exact existing Resolve executable 84 times over a roughly 9-second host window ending at the verified timing completion marker. It observed 111,552 KiB initially, 637,712 KiB last, and a maximum sampled 653,008 KiB. This is process-wide resident memory during a window including setup and result handoff, not a true peak, operation allocation, cache-independent measurement or leak diagnosis.

Untouched native timing result bytes, the path-free rich baseline and the existing portable reviewed trial audit are retained with compressed/raw digests. Focused tests recompute those digests, validate the full portable outcome and represented restoration, and recompute sample counts/maxima. Exact rendered commands, native archives and private runtime receipts remain on this Mac. Hashes do not authenticate copied local editor provenance or authorize ordinary Apply.

The exact host readers used for the native captures are archived separately under `evidence-sources/`. Later host-only hardening binds output directories to the canonical system-temp root and rechecks opened-file identity before tightening permissions. Existing macOS `/var` paths require the explicit system-temp alias mapping. The metadata distinguishes those historical readers from the current readers; all three original private native outputs were successfully reverified with the current readers. Executed Lua, original raw results and measured values remain unchanged.
