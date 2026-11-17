# Release security gates

The repository has no signing identity, notarization credentials, installer pipeline, hosted update feed, or automatic updater. No current build should be described as signed, notarized, or auto-updating.

`src/release-gates.js` contains fail-closed checks for future release automation. `verifyInstallerEvidence` requires a matching artifact SHA-256, platform signature evidence, and a macOS notarization/team match or Windows Authenticode verification. A production pipeline must obtain those facts from `codesign`, `spctl`, Apple notarization, or platform equivalents rather than from user-entered booleans.

Update manifests require an Ed25519 signature verified with a pinned public key, HTTPS artifact URL, content SHA-256, channel, version, and bounded rollout percentage. Eligibility uses a stable installation bucket. The update client must download into a staging area, verify the artifact hash and platform signature, keep the previous version for rollback, and switch only after health checks. The current code verifies policy only; it does not fetch or install updates.

Before release: choose supported operating systems and editor versions, establish signing custody and key rotation, build an installer, notarize where required, test staged rollout and rollback on disposable installs, and publish change notes and an incident path. Keep automatic updates disabled until all gates are proven.
