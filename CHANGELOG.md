# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
