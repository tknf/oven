# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
