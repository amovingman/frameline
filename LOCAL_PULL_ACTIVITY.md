# Verified local pull activity

The desktop Apply panel now shows local completion and restoration activity derived from authenticated retained native transactions. Publication alone produces no completion event: an event requires a bound native resulting revision and completed editor/final closed-file proof.

Event IDs, times and affected revision hashes are deterministic from the immutable journal. Restart and retry do not append duplicates or replay writes. An unreadable or altered journal makes the feed unavailable rather than producing an unverified event. The renderer receives bounded, path-free rows; **Show older activity** pages retained history, and each event opens its transaction records.

The [native activity receipt](phase-0/local-pull-activity-live-proof.json) projects the real in-place Name Apply and restoration outcomes and verifies stable event IDs across restart. Unit and controller tests also cover missing proof, publication-only state, tampering, paging and failed delivery. Review copies retain separate library-qualified completion history.

Existing service activity covers revisions, branches and membership under service authorization. Native local completions stay local: no account, remote branch or project mapping is inferred, and no network message is sent. Managed production retention remains deferred under the personal project scope.
