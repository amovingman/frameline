# Editor expansion gate

The first adapter is the experimental Resolve Free 21.1.2 / FCPXML 1.10 read-only path on macOS. It has no stable clip identity or safe apply transaction, so it is not release ready. No second editor is selected or implemented.

`src/editor-expansion-gates.js` keeps the next-editor decision blocked until the first adapter passes a release gate and the candidate has its own corpus and proven read, identity, diff, write, validation, and recovery evidence. It is a planning check; a caller's `proven` labels are not themselves proof. The evidence must come from repeatable tests on the named editor edition, build, OS, and representative project files, including copied-project write/reopen/restore trials. A candidate should receive its own corpus directory and a separate support-matrix row before implementation.

Do not broaden the shared adapter contract from one implementation. `sharedProvenCapabilities` returns no generalized capability set until at least two release-ready adapters demonstrate the same behavior. Keep unsupported operations explicit and fail closed. Future editor evaluation should compare the same gates used for Resolve, document licensing/API constraints, and reject ambiguous identity or incomplete timeline coverage.

Compatibility statements must name an editor edition and build, OS, format and version, timeline constructs, and tested operations. They must never imply that all project files from an editor—or all video editors—work. See `phase-0/SUPPORT_MATRIX.md` for the current experimental boundary.
