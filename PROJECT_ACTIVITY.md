# Project activity and inbox

The linked service project's History view now has a project activity list and a recipient-scoped inbox. Events and read receipts are saved with the service's encrypted collaboration state. All 690 tests and packaging checks passed, alongside authenticated HTTPS process-restart and browser/native checks.

## Desktop workflow

Sign in and link a service project/branch, then choose **Refresh activity**. **Inbox** shows events addressed to your account; **All activity** shows the project's recorded events. Opening either list does not mark anything read. **Mark read** records an explicit, idempotent receipt for your own inbox item. The unread count covers your whole project inbox, including items outside the displayed page.

Pages contain 20 items. **Show older updates** follows the captured page cursor, with at most 500 items accumulated in the desktop view. Refresh starts again at the newest page. Rows identify the actor and subject by safe IDs; the list does not resolve account emails or expose revision messages or media names. A last-checked timestamp distinguishes displayed observations from current service state.

**Check for updates every 30 seconds** is opt-in and off by default. It refreshes the selected view while this app session remains open. It is not saved across launches. Changing the service, account, local project/branch, or linked remote project/branch clears the displayed scope and turns watching off. Scope changes abort requests and discard late responses. Ordinary state reads perform no network request. App quit stops the timer and drains activity work.

Offline rows describe the last successful check. Permission loss clears project rows and stops watching; the UI reports a generic access change and asks the user to refresh projects and choose an accessible project. Sign-in loss also clears the displayed items. This project watch provides no operating-system notifications or server push. Separately configured notification email can run on the self-hosted server while the desktop is closed; see below.

## Events and durable state

The runtime records actual revision creation, branch changes, and project invitation, join, role change, removal, ownership-transfer, and deletion mutations. Actors are excluded from their own recipient lists, and recipients are deduplicated. No-op membership updates and idempotent revision/branch retries do not append duplicate events. Account deletion records every actual project-role removal while preserving historical owner references on deleted projects; event-capacity failure rolls back deletion and permission changes together. `pull.completed` is an accepted event type, but there is no validated pull-completion producer or editor-apply integration.

Introduced in combined collaboration state schema 2 and preserved in current schema 6, the version-1 activity snapshot is stored alongside identity, access, and schema-3 history. Events and read receipts commit through the same encrypted, serialized transaction as their associated domain changes. An event-append or persistence failure cannot acknowledge the domain mutation alone. Read receipts also persist before acknowledgment. The outer encrypted file format remains version 1.

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

## Account updates and email preferences

History → **Account updates** is independent of the selected local export, Resolve project, or branch binding. Sign in and choose **Refresh account updates** to read your recipient feed across currently accessible projects. Choose All updates or Unread; filtering, refreshing, or opening rows does not mark them read. **Mark read** records an explicit, idempotent account-owned receipt, shared with the project inbox. The unread count covers the visible-to-account feed, not only its displayed page. Pages default to 20, permit at most 100, and the desktop accumulates at most 500 rows.

After access ends, notices addressed to you for your own `member.removed` or `project.deleted` event remain readable with generic copy. Their project ID/name, actor ID, and subject ID are all null. Other inaccessible events are hidden. The account feed never accepts a recipient/account selector. Its optional 30-second watch is off by default and lasts only for the open app session; account/service changes stop it and discard late responses. Ordinary state reads make no network request.

Under **Your email preferences**, choose an accessible service project and **Load email preferences**. Preferences apply only to your own account and email address. Email starts off; Immediate or Daily UTC digest requires an explicit save and a configured server. Daily mode uses a chosen UTC hour, rather than the device's local timezone. Compare-and-swap versions and actor/project-scoped idempotency keys protect saves from stale overwrites and duplicate retries. Reading mail preferences or sending email does not mark events read. Explicit read receipts can remove events from pending messages before submission.

The self-hosted worker persists its outbox and runs independently of desktop watching. First enablement excludes older activity; each job includes at most 100 eligible events. Messages contain update counts and a currently authorized project name, without media/clip names, revision messages, or comment bodies. Permission-loss content omits the former project name. **Turn off all email** disables your preferences and pending jobs even for projects you can no longer access.

An emailed unsubscribe capability turns off only its project's current consent epoch, grants no read access, and returns the same generic receipt for valid and invalid tokens. The page clears the URL fragment and requires an explicit button before posting. A new explicit consent change invalidates an older link. This manual unsubscribe page is not automated RFC 8058 one-click delivery. See [self-hosted mail setup and delivery limits](SERVICE_HOST.md#optional-notification-email).

The authenticated account API adds:

| Method | Route | Input |
| --- | --- | --- |
| GET | `/account/notifications` | Optional `limit`, `cursor`, and `filter=all\|unread` |
| PUT | `/account/notifications/:eventId/read` | Exact JSON `{ "read": true }` |
| GET | `/projects/:projectId/notification-preferences` | No query |
| PUT | `/projects/:projectId/notification-preferences` | `{expectedVersion, mode, digestHourUtc}` and Idempotency-Key |
| POST | `/account/notifications/disable-delivery` | Exact JSON `{}` |

Account pages are exactly `{items, nextCursor, unreadCount}`. Items contain `{id, projectId, projectName, actorId, subjectId, type, at, read, accessLost}`. Signed cursors bind actor, filter, and append anchor, remain bounded to 2,048 characters, and confer no access. Project preference reads/saves recheck current project access; global opt-out needs only the authenticated account. Anonymous `POST /notifications/unsubscribe` accepts only a bounded token body and exposes no account/project data. Notification state was added in combined schema 6; older valid schemas migrate with empty preferences, consents, receipts, and outbox rather than retroactive delivery.

## Validation

The [HTTPS process observation](phase-0/project-activity-network-observation.json), reproduced with `node scripts/service-host-proof.js`, recorded 68 requests across three owned processes. It verified persisted activity/inbox rows and read receipts, duplicate-free idempotent retries, recipient-owned receipts, a cursor surviving restart, cross-account cursor rejection, and denial of a removed viewer's feed and old cursor after restart. Public events and logs omitted private recipients, credentials, and local paths. All owned child processes terminated before replacement and cleanup.

That proof used numeric loopback and a disposable test CA trusted only in isolated child processes. It establishes acknowledged-operation recovery through graceful shutdown, not a crash during a write, production TLS, hosted delivery, or live desktop behavior. The full suite passed all 690 tests with no failures or skips, the expanded security suite passed all 246 tests, and packaging validation passed. The [desktop observation](phase-0/project-activity-desktop-observation.json) records browser inbox paging from 20 to 28 items, explicit read receipts, independent owner/editor/viewer scopes, and the opted-in watch receiving a new revision and permission change over actual HTTPS. Removing the watched member cleared rows/count and stopped checking. All activity paged 33 events before that removal.

Native Electron used real preload/IPC and the OS-backed service account. An explicit receipt reduced the editor inbox from 30 to 29 unread; after a verified full quit/relaunch and matching-source reselection, the account and binding recovered without retyping. Watching started off, the feed required explicit refresh, and the read receipt remained saved. Two bounded visual rounds at 1440, 768, and 390 px showed zero horizontal overflow and at least 44 px phone buttons. A focus repair returns users to status when a Mark read control disappears, while preserving focus they moved elsewhere. A fail-closed selection-error regression clears private cached rows and watch state when the current scope cannot be read.

Both clients signed out, the fixture server exited successfully, its data and private locator were removed, and the browser tab closed and viewport reset. The native vault retained zero service entries; no media-transfer directory was created. The ordinary app reopened signed out without the test CA override. The browser used fixture chooser/vault adapters; native IPC and OS-vault checks were separate. These clients ran on one Mac, so physical cross-device operation and production delivery remain unverified.

The later notification test, `node --test tests/self-hosted-notifications-proof.test.js`, passed 44 actual HTTPS requests across three hosts and three clients. It covered account pagination/read ownership, exact preference retry, a background message accepted over TLS by a private fake MTA, unsubscribe epoch changes, restart persistence, generic removal/deletion notices, and opt-out after access loss. It sent no external email and does not establish production delivery or a real elapsed daily schedule.

The [notification desktop observation](phase-0/notifications-live-observation.json) records native opt-in, verified clean quit, and actual server delivery of two synthetic update counts while the desktop was closed. Restart restored the account and preference; an explicit read receipt remained read after another restart, with watching off. Native daily-UTC selection produced one real TLS-submitted digest after a private injected-clock advance, without an early or duplicate message. A browser recipient explicitly unsubscribed and the native setting read back Off; a later event and cutoff produced no further email. Viewer preferences were independent of the owner, and a removed viewer could read only a generic own access-loss notice, mark it read, and stop all email. The unsubscribe page had no horizontal overflow at 1440, 768, and 390 px and loaded the bundled Plex face. A misleading initial unread zero was corrected to “Unread not checked.”

The milestone passed 1,176 full-suite tests, 789 security checks, package validation, and 50 final controller/renderer checks after that copy fix. An earlier concurrent security run timed out in an existing Resolve process proof; the standalone security rerun passed. Both clients signed out with zero vault entries, all private test capabilities/data were removed after the fixture exited with code 0, and the ordinary app returned without test trust overrides. No external email was sent. The daily test advanced an injected clock; it did not wait an elapsed day.
