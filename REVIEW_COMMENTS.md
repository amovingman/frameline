# Revision-anchored review comments

The self-hosted service and desktop **Resolve service history** panel support comments on the explicitly fetched incoming Resolve revision. Refresh loads that revision's thread; users can select an observed clip or enter a half-open frame range, post plain text, page older comments, and mark permitted comments resolved. Comments remain attached to the immutable revision where they were created. They do not follow later revisions or change the editor.

## Verified anchors and permissions

`src/service-review-comments.js` resolves the service project and revision to its canonical immutable manifest, validates the Resolve observation, and checks the anchor against that observation. Service project IDs identify collaboration resources; they are not Resolve API project UUIDs. The desktop separately checks that the fetched observation's Resolve project UUID matches the selected local Resolve history. Timeline and clip IDs are exact observed IDs, including supported opaque Unicode IDs; names, positions, and FCPXML resource references are not substitutes.

Anchors have one of these exact shapes:

```js
{ kind: 'clip', timelineId, clipId }
{ kind: 'range', timelineId, startFrame, endFrame }
```

A range requires safe integer frames, starts at or after the observed timeline start, and ends after its start and no later than the last observed item end. Empty timelines cannot establish a range. The service supports validated Resolve manifest versions 1–3, including richer observations and transaction-audit snapshots. FCPXML manifests and unknown clip/timeline IDs are refused. This proves an anchor in a saved observation, not current live-editor identity or cross-revision correspondence.

Every request authenticates the account and checks current project membership. Owners and editors can post. All current roles can read. The author or a current owner can resolve a comment; an author downgraded to viewer can still resolve their own comment while retaining project access. Other editors cannot resolve another author's comment. Resolution is one-way and idempotent. Removed members, deleted projects, revoked sessions, and deleted accounts lose access; historical author references remain with retained comments.

Bodies are trimmed, nonempty plain text of at most 1,000 characters. Line feeds and tabs are accepted; other control characters are refused. HTML-looking text remains text. No notification, edit, delete, mention, attachment, or cross-revision remapping workflow is included.

## Persistence and HTTP boundary

The combined encrypted collaboration state is schema 3. Opening valid schema 1 or 2 atomically adds an empty version-1 comment snapshot, preserving identity, access, history, and existing activity where present. Schema 1 also receives empty activity without replay. Existing IDs and credentials are preserved; future schemas and invalid cross-project/revision/user/anchor references fail closed. Comment records and hashed idempotency receipts share the existing locked, encrypted transaction and acknowledgment protocol. The outer encrypted file format remains version 1.

Creation requires an idempotency key. Its saved hash is scoped to authenticated author, service project, and immutable revision; an identical retry returns the existing comment, while a different body or anchor with that key is refused. The service retains no raw creation key. Comment state is bounded to 20,000 comments/receipts and 16 MiB; reaching capacity refuses the mutation without partial publication.

The existing authenticated HTTPS transport exposes:

| Method | Route | Input |
| --- | --- | --- |
| GET | `/projects/:projectId/revisions/:revisionId/comments` | Optional `limit` and `cursor` query fields |
| POST | `/projects/:projectId/revisions/:revisionId/comments` | `{anchor, body}` and required `idempotency-key` header |
| PUT | `/projects/:projectId/revisions/:revisionId/comments/:commentId/resolve` | `{resolved: true}` |

Pages default to 20 comments and accept at most 100. Signed cursors are bound to the authenticated reader, project, revision, and initial page anchor. Append ordering avoids same-timestamp gaps; later additions do not enter an already-started page traversal. Pages include current total/open counts. Cursors are opaque and bounded to 2,048 characters. Public records include author/resolution IDs and current `canResolve`, without private receipts or signing secrets.

## Desktop behavior and validation boundary

The main process derives the target from the selected Resolve history's verified fetched cache. The renderer supplies comment intent and an opaque expected scope ID; it cannot choose the account, service revision, source file, or network destination. A stale draft scope is rejected before posting. Account, branch, binding, fetched-target, and relevant permission changes invalidate the displayed thread. Resolve acknowledgments must preserve the comment's immutable content. A failed acknowledgment can be retried with the same in-memory request key for the same target and intent; the service's durable receipt prevents duplicates. Pending drafts and retry keys are not persisted across app restarts.

State reads use local verified metadata and make no network request. Refresh, paging, posting, and resolution are explicit network actions. The desktop shows at most 500 comments and limits target selection to 2,000 timelines/20,000 observed items. Bodies render as text. Comments do not import incoming history, move a branch, access the clipboard, write editor properties, or authorize Apply.

Focused domain, encrypted-runtime, transport, and actual loopback HTTPS restart tests cover exact anchors, permissions, retry, pagination, migration, and persistence failures. All 872 full-suite and 485 security tests passed with no failures or skips. The [live observation](phase-0/revision-comments-live-observation.json) records real HTTPS browser and native Electron checks: owner clip/range posting and resolution, Unicode and literal HTML-looking text, stale-draft discard, native app restart with the saved session and exact fetched head, and viewer reads with posting disabled and no resolution controls for other authors. Two visual rounds at 1,440, 768, and 390 pixels found no overflow. Native refresh recovered six comments, including the resolved native clip comment; encrypted-state validation confirmed two resolved and four open comments on the same exact revision. Native sign-out cleared comment bodies, disabled posting, and removed saved credentials.

The UI/service fixture used a copied observation with a synthetic Resolve project identity and synthetic accounts on loopback. No editor mutation ran. This completes the self-hosted Resolve comment workflow on disposable immutable observations. Public hosting, broader editor compatibility, user-research acceptance, and safe project apply are not established.

## Earlier local foundation

`src/review-comments.js` remains the separate local file-store foundation with caller-supplied authorization and anchor verification. It is not the HTTP backend. The self-hosted workflow above uses `src/service-review-comments.js` inside the combined encrypted runtime.
