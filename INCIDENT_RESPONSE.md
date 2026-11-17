# Incident response and recovery

This procedure applies to local builds and the in-process service foundation. There is no operated hosted service, on-call rotation, or configured private security inbox yet. Those are release blockers.

1. **Triage and contain.** Record the build version, affected capability, start time, and generic error codes. Stop risky writes, transfers, or update rollout. Preserve project files and the app's local data directory before retrying. Do not put paths, credentials, media names, or project content in public tickets.
2. **Protect evidence.** Keep the original local metadata, its `.bak` file, immutable revision records, and any damaged file preserved by recovery. Export the reviewed diagnostics report only with the editor's consent. Store access to evidence privately and restrict it to responders.
3. **Assess scope.** Separate local corruption, compatibility mismatch, unauthorized access, sync divergence, and release/update failure. Do not infer that a successful scan proves a safe apply. Record the exact supported editor/build and corpus fixture that reproduced the issue.
4. **Recover.** For local metadata, use the validated backup recovery path and keep the damaged primary for investigation. For service state, use `createServiceBackup`, `restoreServiceBackup`, and `runRestoreDrill` on an isolated copy before replacing any live state. A failed update must retain the previous version and restore it before marking recovery complete. Never overwrite a concurrent remote branch head.
5. **Verify and communicate.** Reopen affected projects read only, check revision/manifest hashes and branch heads, run the relevant compatibility tests, then document impact, remediation, and remaining uncertainty. Communicate directly to affected users through a private channel established for the pilot.

**Security disclosure:** Do not publish exploit details in a compatibility issue. Before any beta release, configure a private intake address or GitHub private vulnerability reporting, designate an owner and backup responder, and publish response targets. Until that intake exists, security issues require direct private contact with the repository owner; do not claim a public disclosure program is operational.

**Backups:** local metadata writes create a backup, and the service foundation provides a hashed export and restore drill. Neither is a managed off-device backup. A production deployment must define encrypted off-device backup frequency, retention, access control, restore owner, recovery-time target, and regular restore-drill evidence.
