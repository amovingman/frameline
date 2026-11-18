# Project activity and inbox

The linked service project's History view now has a project activity list and a recipient-scoped inbox. Events and read receipts are saved with the service's encrypted collaboration state. All 690 tests and packaging checks passed, alongside authenticated HTTPS process-restart and browser/native checks.

## Desktop workflow

Sign in and link a service project/branch, then choose **Refresh activity**. **Inbox** shows events addressed to your account; **All activity** shows the project's recorded events. Opening either list does not mark anything read. **Mark read** records an explicit, idempotent receipt for your own inbox item. The unread count covers your whole project inbox, including items outside the displayed page.

Pages contain 20 items. **Show older updates** follows the captured page cursor, with at most 500 items accumulated in the desktop view. Refresh starts again at the newest page. Rows identify the actor and subject by safe IDs; the list does not resolve account emails or expose revision messages or media names. A last-checked timestamp distinguishes displayed observations from current service state.

**Check for updates every 30 seconds** is opt-in and off by default. It refreshes the selected view while this app session remains open. It is not saved across launches. Changing the service, account, local project/branch, or linked remote project/branch clears the displayed scope and turns watching off. Scope changes abort requests and discard late responses. Ordinary state reads perform no network request. App quit stops the timer and drains activity work.

Offline rows describe the last successful check. Permission loss clears project rows and stops watching; the UI reports a generic access change and asks the user to refresh projects and choose an accessible project. Sign-in loss also clears the displayed items. No operating-system notification, email, digest, server push, or delivery while the app is closed is configured.

## Events and durable state

The runtime records actual revision creation, branch changes, and project invitation, join, role change, removal, ownership-transfer, and deletion mutations. Actors are excluded from their own recipient lists, and recipients are deduplicated. No-op membership updates and idempotent revision/branch retries do not append duplicate events. Account deletion records every actual project-role removal while preserving historical owner references on deleted projects; event-capacity failure rolls back deletion and permission changes together. `pull.completed` is an accepted event type, but there is no validated pull-completion producer or editor-apply integration.

Combined collaboration state schema 2 includes the version-1 activity snapshot alongside identity, access, and schema-3 history. Events and read receipts commit through the same encrypted, serialized transaction as their associated domain changes. An event-append or persistence failure cannot acknowledge the domain mutation alone. Read receipts also persist before acknowledgment. The outer encrypted file format remains version 1.

Opening valid combined schema-1 state atomically upgrades it with an empty activity list and empty receipts. Existing history is preserved; it is not replayed or backfilled into synthetic activity. Hydration validates saved events without emitting new events. Recovery checks the hash chain, exact fields, unique event IDs, receipt ownership, and project/user/subject references together with the rest of the combined state.

The activity snapshot is bounded to 16 MiB, 20,000 events, 100,000 aggregate recipient references, and 100,000 read receipts. One event accepts at most 10,000 recipient inputs. Capacity failures refuse the operation; no automatic pruning or activity-retention policy is implemented. The runtime's separate combined-state bounds still apply. See [durable collaboration storage](DURABLE_COLLABORATION_SERVICE.md) for filesystem, encryption, and rollback limits.

## HTTPS contract and privacy

The existing authorized metadata handler/client expose:

| Method | Route | Input |
| --- | --- | --- |
| GET | `/projects/:projectId/activity` | Optional `limit` and `cursor` query fields |
| GET | `/projects/:projectId/notifications` | Optional `limit` and `cursor` query fields |
| PUT | `/projects/:projectId/notifications/:eventId/read` | Exact JSON `{ "read": true }` |

Every request authenticates its bearer header and rechecks current project access. A read receipt requires the event to belong to that account's recipients in that project. Removed members and deleted projects cannot use old cursors to recover details. HTTPS, API-version/request-ID envelopes, bounded JSON, strict response validation, and rejection of browser `Origin` requests apply as described in [revision network sync](REVISION_NETWORK_SYNC.md).

Pages have exactly `{projectId, items, nextCursor, unreadCount}`. Activity items contain only `{id, projectId, actorId, type, subjectId, at}`; inbox items add `read`. Activity pages return `unreadCount: null`; inbox pages return the total unread count. Public responses omit recipient IDs, receipt maps, hash-chain fields, emails, credential material, and local paths.

The default page limit is 20 and the maximum is 100. Unknown or duplicate query fields are refused. Cursors are canonical, HMAC-signed strings bounded to 2,048 characters and bound to the account, project, feed kind, and append-position anchor. They are not credentials. Newest-first order follows immutable append position, so tied timestamps and clock rollback do not lose events between pages. New appends appear after refreshing the newest page rather than shifting an existing pagination anchor. The signing secret survives service restart in private encrypted state.

## Validation

The [HTTPS process observation](phase-0/project-activity-network-observation.json), reproduced with `node scripts/service-host-proof.js`, recorded 68 requests across three owned processes. It verified persisted activity/inbox rows and read receipts, duplicate-free idempotent retries, recipient-owned receipts, a cursor surviving restart, cross-account cursor rejection, and denial of a removed viewer's feed and old cursor after restart. Public events and logs omitted private recipients, credentials, and local paths. All owned child processes terminated before replacement and cleanup.

That proof used numeric loopback and a disposable test CA trusted only in isolated child processes. It establishes acknowledged-operation recovery through graceful shutdown, not a crash during a write, production TLS, hosted delivery, or live desktop behavior. The full suite passed all 690 tests with no failures or skips, the expanded security suite passed all 246 tests, and packaging validation passed. The [desktop observation](phase-0/project-activity-desktop-observation.json) records browser inbox paging from 20 to 28 items, explicit read receipts, independent owner/editor/viewer scopes, and the opted-in watch receiving a new revision and permission change over actual HTTPS. Removing the watched member cleared rows/count and stopped checking. All activity paged 33 events before that removal.

Native Electron used real preload/IPC and the OS-backed service account. An explicit receipt reduced the editor inbox from 30 to 29 unread; after a verified full quit/relaunch and matching-source reselection, the account and binding recovered without retyping. Watching started off, the feed required explicit refresh, and the read receipt remained saved. Two bounded visual rounds at 1440, 768, and 390 px showed zero horizontal overflow and at least 44 px phone buttons. A focus repair returns users to status when a Mark read control disappears, while preserving focus they moved elsewhere. A fail-closed selection-error regression clears private cached rows and watch state when the current scope cannot be read.

Both clients signed out, the fixture server exited successfully, its data and private locator were removed, and the browser tab closed and viewport reset. The native vault retained zero service entries; no media-transfer directory was created. The ordinary app reopened signed out without the test CA override. The browser used fixture chooser/vault adapters; native IPC and OS-vault checks were separate. These clients ran on one Mac, so physical cross-device operation and production delivery remain unverified.
