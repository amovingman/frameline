# Personal local upgrade and migration recovery

The owner workflow now has a repeatable manual-code-upgrade drill for Frameline's local history database. It runs an actual historical schema-4 reader from commit `71219f13e7b94c916b07ef400591b5fca9968171` and the current schema-5 reader in separate Node processes. All inputs are disposable. No installer, application binary switch, automatic updater or real owner workspace is involved.

The archived reader includes its nine repository-source dependencies, preserved byte for byte under a fixed archive hash. It runs with the current installed Node/npm environment; the receipt records that environment, parser entry hash and package-lock hash. This is not a claim that an old packaged application was installed or that an earlier Node runtime was tested.

## What the drill proves

The historical reader creates one project, three immutable revisions, two branches and a legacy sync base from the retained 50-clip editor export. The current reader migrates the actual metadata index from schema 4 to 5. Project/revision IDs, every original record byte, selected branch, branch heads and legacy bases remain unchanged; service-scoped bases begin empty.

Two real `SIGKILL` interruptions stop migration after backup publication but before primary replacement, and after primary replacement but before acknowledgment. Snapshots preserve each interrupted state before recovery. A fresh current reader reclaims its dead-owner metadata lock and recovers the same graph. Unpublished temporary files remain retained; this drill does not add automatic deletion of unknown migration artifacts or claim machine power-loss durability.

The actual historical reader refuses the newer schema-5 primary while a valid schema-4 backup exists. It leaves canonical metadata, backup and immutable records unchanged instead of silently downgrading through that backup. The current reader separately refuses a future schema-6 primary with a valid old backup. A schema-1 project-ID migration is also exercised.

After upgrade, the current reader writes a fourth revision. Restoring the original backup into a **separate empty workspace** lets the historical reader recover the exact original graph and bytes while preserving the newer workspace and its fourth revision. A normal `.bak` file rotates on later writes; it is not a permanent pre-upgrade rollback archive.

## Owner procedure for a manual development update

1. Finish or recover any active operation and close Frameline.
2. Keep a private, separate copy of the complete selected workspace and app data before changing code. History exports contain observations, not native project/media payloads or all app state; retain the independent native restore points and media backups too.
3. Try the new code against a separate copy first. Verify history, branch heads and retained records before writing new work. Keep the original workspace and code available.
4. If the older reader refuses newer data, preserve that data. Restore the pre-upgrade workspace into a new empty location and explicitly choose it. Do not replace the newer workspace with an older backup.

The drill verifies the local history migration and refusal/restore mechanisms. Credential vaults, native journals and optional service stores have separate formats and existing recovery tests. Signed installer upgrades, binary activation, automatic update rollback and public release channels remain deferred.

## Verification

```sh
npm run verify:local-migrations
npm run audit:local-migrations
node --test tests/local-migration-drill.test.js
```

The verifier creates new disposable profiles and records [the public receipt](phase-0/local-migration-proof.json). Exact metadata, immutable records, historical source files and process-interruption snapshots remain in ignored private retention. The auditor checks their manifest, source pins, complete record/branch relationships and both interruption endpoints without running a reader, acquiring a metadata lock, repairing files or installing software. Linked, changed or path-traversing artifacts fail verification.

Final repository validation passed 2,434 tests with zero failures or skips, package checks, and the composed read-only native evidence audits. Seven migration-specific tests independently exercise real reader processes and adversarial retained artifacts.
