# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] - 2026-07-11

### Added

- Added `TestBroadcaster` to `@tknf/oven/test`, joining `TestJobQueue`/`TestMailer`: records every publish (`published`, `publishedTo(channel)`, `clear()`) and genuinely delivers to `subscribe`d listeners.
- Added `{SQLite,Pg,MySql}PruneExpiredRecordsJob` for the DB-backed `KeyValueStore`/`SessionStorage` tables: batched garbage collection via `{ db, targets, batchSize?, maxBatches? }` (each target names its own table/pk/expiry columns).
- Added a `widget: "file"` `FieldDef` variant for file inputs, plus `validateUploadedFiles()` / `toUploadedFileFormErrors()` for batch validation of `multiple: true` upload fields.
- Added the `oven generate admin-resource <Name>` CLI generator, scaffolding an `AdminResource` subclass with its `Model`/table injected via the constructor; `--dialect` is now rejected with an explicit error for every generator type that doesn't accept it (previously silently ignored).
- Added a `rateLimiter` option to `AdminPanel`: throttles the built-in `POST /login` route (keyed `admin-login:${normalized username}`, so case/whitespace variants share one budget, `429` on exceed, counter reset on success); a one-time `SEC-302` warning is logged when login is wired without it.
- Added a `bodyLimitBytes` option to `AdminPanel`: rejects an oversized multipart request via `hono/body-limit` before CSRF verification or body parsing runs.
- Added a strict default Content-Security-Policy header to every `AdminPanel` response; override it with a custom policy string or disable it via the `contentSecurityPolicy` option.
- Added session invalidation on admin credential changes: with `accounts` injected, a `passwordStamp` on the session identity is re-verified on every request, so changing a password — or enabling, disabling, or re-enrolling TOTP — invalidates every other outstanding session.
- Added automatic reconnection to `DurableObjectBroadcaster` with exponential backoff (`reconnectInitialDelayMs`/`reconnectMaxDelayMs`) and `onDisconnect`/`onReconnect` hooks; set `reconnect: false` to restore the previous no-reconnect behavior.
- Added `OffsetPaginationView` / `OffsetPaginationViewProps` to `@tknf/oven/pagination` (and the package root): numbered-page pagination for bounded back-office screens, alongside the existing cursor-based `PaginationView`.
- Added opt-in per-account lockout to the admin accounts services: `sqliteAdminUserLockoutColumns()` / `pgAdminUserLockoutColumns()` / `mysqlAdminUserLockoutColumns()`, a `lockout: { maxAttempts, lockDurationSeconds }` service option, and `unlockUser(userId)`.
- Added `GcsUrlSigner` to `@tknf/oven/storage`: GCS V4 signed GET URLs (`GOOG4-RSA-SHA256`) from a service account's `client_email`/`private_key`.
- Added RFC 6238 TOTP two-factor authentication for admin operators: a Base32 codec (`@tknf/oven/support`), TOTP primitives (`@tknf/oven/auth`), and opt-in column factories plus `beginTotpEnrollment`/`confirmTotpEnrollment`/`verifyTotp`/`disableTotp` on the admin accounts services, wired into the built-in login flow as an automatic second step.
- Added `Model#deleteWhere(where)` to `SQLiteModel`/`PgModel`/`MySqlModel`: the bulk hard-delete counterpart to `updateWhere`, returning the number of rows removed.
- Added `PasswordlessLogin` to `@tknf/oven/auth`: a headless magic-link login flow (third sibling of `EmailVerification`/`PasswordReset`), single-use via a per-user rotating nonce that `login` consumes atomically (compare-and-swap), so a link cannot be replayed even under concurrent requests.
- Added a CSV export action to every `AdminPanel` resource list (`GET /resources/<key>/export.csv`), built on `@tknf/oven/view`'s `View` and `@tknf/oven/helpers`' `csvDocument`: it respects the current search/filter/sort, is gated by the same `resource.<key>.view` permission as the list, keeps formula-injection guarding on by default, and is capped at 10,000 rows.

### Changed

- `AdminResourceListViewProps` (exported from `@tknf/oven/admin`) gained a required `exportHref: string` field for the new CSV export link; a direct consumer of the exported `AdminResourceListView` must now supply it. `AdminCatalog` also gained new required keys for the CSV export and TOTP UI strings, which affects only a hand-rolled custom catalog.
- `AdminAccountsUserRow`'s structural contract now declares the `passwordHash: string` field all three dialect services already returned.
- `S3Storage#put` and `GoogleCloudStorage#put` now switch to multipart/resumable upload protocols automatically for known-size bodies above 100 MiB; behavior for smaller bodies and streams is unchanged.
- `failedAttempts`/`lockedUntil` (admin account lockout) and `totpSecret`/`totpEnabledAt`/`totpLastUsedStep` (admin TOTP) are now reserved column names on the admin users table.

### Deprecated

- `SignedCookieAccessor` / `SignedCookieDefinition` are now `@deprecated`, with removal planned for the next major. Use `CookieAccessor` combined with explicit signing, or call Hono's `getSignedCookie`/`setSignedCookie` directly.

## [1.1.0] - 2026-07-10

### Added

- Added an `except` option to `Guard` — an exact-match list of request paths that pass through the guard entirely, so opening a public path (e.g. a login page) inside a protected range no longer depends solely on registration order.
- Added a `keyPrefix` option to `KeyValueSessionStorage` (default `"oven_session:"`, unchanged) to namespace multiple session purposes on a shared store, or to match an existing key scheme when migrating.
- Added `CloudflareEmailMailer` to `@tknf/oven/cloudflare`: a `Mailer` for the Workers Email Sending binding (`send_email`), using the binding's structured builder API; attachment content is base64-encoded automatically.
- Added `DurableObjectBroadcaster` and `BroadcasterDurableObject` to `@tknf/oven/cloudflare`: a Durable Objects-backed multi-instance `Broadcaster` (one Durable Object per channel, WebSocket Hibernation on the server side; at-most-once delivery, no reconnection).
- Added `Session.isDestroyed` / `Session.markDestroyed()` (set by every `SessionStorage#destroy`) as part of the destroy-wins fix below.
- Documented a tenant-scoped model recipe for multi-tenant apps (`docs/models.md`), and the `layout()`/`middleware()` leak when mounting a `RouteHandler` at the app root (`docs/routing.md`).

### Fixed

- Destroying a session now always wins over the automatic dirty commit: `SessionAccessor` skips committing a destroyed session, so a `flash` in the same request as a logout no longer revives the session (and its cookie) after the `Max-Age=0` destroy cookie has gone out.

## [1.0.0] - 2026-07-10

First published release on npm.

### Changed

- Renamed the public test-harness subpath export from `@tknf/oven/test-support` to `@tknf/oven/test`, and unified the internal folder to `src/test/`.

### Security

- Added a CSRF verification hook to `AdminPanel`, moving write routes toward a secure-by-default posture.
- Added an `authorize` hook to `BroadcastWebSocket` to prevent Cross-Site WebSocket Hijacking.
- Rejected `..` segments in S3-family Storage `key`s (path traversal prevention).
- Fixed `MySqlModel#delete` to verify whether the delete actually occurred.
- Added runtime warnings for an unset cookie `secure` attribute and low-entropy `secrets`.

### Fixed

- Fixed the job worker claim to write the actual claim time into `lockedAt` (prevents double execution caused by a shortened visibility window).
- Fixed `ScopedValueAccessor` (`scope: "app"`) so it no longer permanently caches a failed initialization.

### Added

- Added index declarations to the bundled table factories (jobs / broadcasts / kv / session / audit).
- Added timeout configuration to external `fetch` calls (OAuth / Mailer / S3 Storage / Upstash).
- Added CI (GitHub Actions) running format / lint / typecheck / test.

## [0.1.0] - Unreleased

- Initial release (not yet published to npm).
