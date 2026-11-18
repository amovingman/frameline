# Release policy

Frameline is currently a local experimental build. No stable or beta installer is available. A release channel is a policy label; it does not bypass signing, compatibility, recovery, or updater gates.

| Channel | Intended audience | Entry gate |
|---|---|---|
| Experimental | Local development and named compatibility probes | Tests and exact editor/build/OS/format boundary in notes. No automatic update promise. |
| Beta | Invited pilots on a published support matrix | Signed artifact, notarization where required, backup/restore drill, rollback test, and private incident intake. |
| Stable | Publicly supported users | Beta evidence plus representative project corpus, reliability targets, accessible core workflows, and an operated support process. |

Versions use `major.minor.patch` without implicit prerelease ordering. `src/release-policy.js` rejects nonincreasing versions, missing change notes, and undefined local data schema ranges. This is a planning gate. An update also requires a signed manifest and verified platform artifact; `src/update-recovery-policy.js` describes recovery decisions but does not install software. The current local metadata index schema is 5. Combined collaboration state uses schema 2 with outer encrypted format 1; immutable service history uses schema 3, and the optional asset index uses schema 2. These version numbers belong to separate formats. A client must refuse to open data newer than its declared readable range; downgrade must not overwrite it. Migration must make a verified backup before replacing local state.

Every candidate release needs dated change notes covering user-visible changes, compatibility changes, migrations, known limitations, recovery steps, and the exact editor edition/build, operating system, and project format tested. Keep `CHANGELOG.md` current. Publish a release only after the signing and update gates in `RELEASE_SECURITY.md` are complete.
