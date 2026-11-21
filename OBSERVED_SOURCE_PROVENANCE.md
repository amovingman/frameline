# Historical native execution and current observations

The native pull, native result-history, and proxy-safe derived-import receipts retain the source hashes of the code that actually produced their SDK observations. Their main/index hashes refer to commit `65a43a9`. Adding session operation-health observations later does not turn those earlier native operations into fresh executions of the new build.

Exact observed sources are archived under `phase-0/evidence-sources/observability-transition/`: main, index, and the three evidence auditors. Each archive must match its original receipt pin. The historical receipts and their SDK/editor admission hashes remain unchanged.

The shared `scripts/observed-source-provenance.cjs` permits only these exact changes:

- In main, the operation-health import/collector, one asset-transfer observation, four existing state-callback observations, and the diagnostics snapshot property. Removing the seven exact insertion strings must recover the archived main byte for byte.
- In index, only the diagnostics optional-details checkbox label changes from session scan performance to session performance and operation health. Reversing that exact label replacement must recover the archived HTML byte for byte.
- In each of the three auditors, only its original raw source-hash comparison becomes a call to the shared strict validator. Reversing that single exact expression replacement must recover the archived auditor byte for byte.

All other pinned sources—including native plans, identity readers, guards, transactions, publishers, preservation helpers, SQLite scripts, and emitted SDK commands—still require the exact original hash. An unrelated source change has no fallback or exemption. Historical main/index pins cannot be silently replaced with current hashes.

The transition also requires a fresh two-process observability desktop proof with current source hashes for main/index, logger, event/error catalog, operation health, and the reviewed diagnostics path. It checks actual worker scan health, pending native work remaining unverified, fixture-only callback states, stale-review refusal before the save dialog, optional detail exclusion, exact consented export bytes, private export permissions, readable layouts, and session reset. These callback fixtures establish observation wiring; they are explicitly not another SDK publication or editor admission.

Five current desktop integration receipts are separately retained for native pull, native result history, relinked copies, local integrity, and integrated crash recovery. Their bytes and current producer hashes are bound in the transition. The integrated crash-recovery receipt also independently binds all its current implementation source hashes, including main/index. Disposable hardware/editor inputs in those proofs retain their stated limits.

After those proofs finish against stable sources, `node scripts/record-observability-transition.cjs` verifies every relationship before writing `phase-0/observability-provenance-transition.json`. It runs no editor operation and does not rewrite native receipts. The three native auditors then compose exact historical execution evidence with the bounded current observation-only transition. A missing archive, extra edit, stale current proof, changed core source, or altered proof hash causes refusal.

This establishes an explicitly limited provenance transition, not fresh live-editor equivalence for arbitrary code changes. It grants no new Apply, restoration, native write, lossless import, public-release, or concurrent-writer exclusion authority. A later effectful or otherwise unlisted change requires its own implementation review and appropriate fresh execution evidence.
