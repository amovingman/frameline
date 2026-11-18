# Later feature gates

Most modules here remain local foundations. Protected branch review now has an integrated self-hosted metadata workflow. The remaining delivery, editor-write, and rendering controls stay unavailable until their respective release gates are met.

| Capability | Current foundation | Required before product use |
|---|---|---|
| Protected branches | `service-branch-protection.js` persists owner policy versions, exact-head requests, independent approvals, expiry, and applied receipts in encrypted combined schema 4. Actual queued pushes are gated in the branch transaction with matching activity; desktop review and real HTTPS/browser/native checks passed. Legacy `branch-protection.js` remains a local reference. | The self-hosted metadata feature is complete; managed deployment, physical cross-device operation, and editor writes remain separate gates. See [branch approvals](COLLABORATION_FOUNDATIONS.md#branch-approvals-on-a-self-hosted-service). |
| Notification preferences | `notification-preferences.js` plans immediate, daily UTC, or off delivery from an already authorized activity inbox; default is off. | Consent and preferences UI, durable receipts, scheduler, recipient delivery, and unsubscribe handling. |
| Project presets | `project-presets.js` stores bounded branch and media-class choices and emits a plan. | Durable team authorization, an atomic application transaction, and UI that previews changes. |
| Studio storage | `shared-storage-candidate.js` verifies one selected regular file by size and hash inside a canonical root without returning paths. | A supported shared-volume integration, mount/identity policy, permissions, failure recovery, and explicit relink workflow. |
| Asset lifecycle | `asset-lifecycle-policy.js` plans deletion against retained revisions, shared assets, and manual holds. It performs no deletion. | Durable holds, multi-project enforcement, retention deadlines, audit trail, owner confirmation, and transactional garbage collection. |
| Live co-editing | `later-feature-gates.js` requires proven identity, editor events, transactional recovery, a reliable first adapter, and user research. | A separately designed concurrency model and real-world evidence. The gate never enables the product. |
| Cloud rendering | `later-feature-gates.js` requires opt-in, media rights, processor contract, region, cost limit, and output provenance. | Separate product scope, security review, user consent, and cost/rights controls. The gate never sends media. |

## Cross-cutting evidence

- **Data safety:** existing immutable revision records, verified backups, atomic metadata writes, and restore tests remain the base. New branch approvals recheck reviewer access and head state; lifecycle holds only produce deletion plans. Hosted durability and end-to-end restore drills remain open.
- **Correctness:** `resolve-anchor-evidence.js` validates the exact source-bound Resolve snapshot hash before recognizing a clip ID or bounded frame range. It does not infer identity from a name or position. FCPXML clip identity is still unresolved; the compatibility corpus remains the read-only regression gate.
- **Honesty:** the desktop media summary now separates local, missing, external unchecked, unspecified, and inaccessible references. Sample timeline and media remain labeled. Unsupported apply and pull controls remain disabled.
