# Revision-anchored review comments

`src/review-comments.js` stores local comments on an exact immutable revision. A comment can target a verified timeline clip ID or a half-open frame range. The caller supplies project authorization and an anchor verifier that checks that revision's authoritative editor snapshot; names, positions, and FCPXML resource references are not accepted as identity evidence.

The file is written atomically with private permissions. Readers need project read access; writing needs comment permission; resolving is limited to the author or a comment manager. Comments do not move automatically to later revisions, and the current FCPXML scanner cannot verify stable clip IDs. No desktop comment UI, hosted delivery, or cross-revision remapping is available. Keep this feature gated until those pieces are proven.
