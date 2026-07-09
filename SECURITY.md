# Security Policy

## Supported versions

`@tknf/oven` is currently `0.x` (pre-release). Security fixes are provided only for the latest minor/patch release.

| Version | Supported      |
| ------- | -------------- |
| 0.x     | ✅ latest only |

## Reporting a vulnerability

If you find a vulnerability, please **do not open a public issue**. Report it privately instead.

- Use GitHub "Security Advisories" (Report a vulnerability) to report privately.
- If that is unavailable, contact the maintainers directly.

Please include:

- Affected module, file, and version
- Steps to reproduce (a minimal PoC is appreciated)
- Expected impact (data disclosure, tampering, DoS, etc.)

## Our process

- We aim to send an initial response as quickly as possible after receipt.
- We assess impact and severity and share a plan for the fix release.
- After the fix ships, we disclose it, crediting the reporter if they wish.

## Important operational notes for users

This library makes a few intentional design choices that favor developer convenience over "secure by default." **Make sure to review the following before running in production.**

- The `secure` attribute on the session cookie and remember token is not set by default. In production, set `secure: true` explicitly via the cookie options.
- The `secrets` passed to `Encrypter` / `UrlSigner` / `CookieSessionStorage`, etc. must be high-entropy random values of ~32 bytes (do not use a human-chosen passphrase).
- When mounting `AdminPanel`, wire CSRF verification into the write routes (use the panel's CSRF option, or verify upstream).
- When using `BroadcastWebSocket`, always perform Origin checking and connection authorization in the `authorize` hook or inside the `channels` callback (to prevent Cross-Site WebSocket Hijacking).
- When using user input as a Storage `key`, sanitize it on the application side so it contains no `..` or path separators.
