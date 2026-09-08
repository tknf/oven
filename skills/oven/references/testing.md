# Testing oven applications

`@tknf/oven/test` provides `createTestDb({ schema, migrationsFolder })` (throwaway
libSQL DB), `defineFactory(persist, defaults)`, `actingAs(storage, { identityKey,
identity })` (auth cookie), and `TestJobQueue`/`TestMailer`/`TestBroadcaster`
(record instead of performing) — the fakes still run real validation, and
`TestBroadcaster` also delivers to its own `subscribe`d listeners like
`InMemoryBroadcaster`. Drive the app via `app.request(...)`.

For client-driven multipart uploads, inject one `InMemoryStorage` instance
(`@tknf/oven/storage`) as `Storage & MultipartUploader`. It holds upload state
between calls, validates references and completion metadata, and publishes
assembled bytes only on completion, returning their actual byte count as
`MultipartUploadResult.size`. Small parts are allowed; R2 size/count
limits, expiry, and provider error types require binding integration tests.

For `Guard` request authentication, use a real Hono app with an environment that
has the subject variable but no session. Supply the verifier callback explicitly;
cover nullish results, propagated errors, sequential and overlapping requests,
exact excluded paths, and no-store. `actingAs` applies to session authentication;
it does not authenticate a request-mode guard. Test an independent `SessionAccessor`
plus `Csrf` for browser forms, and keep mixed/incomplete mode type checks alongside
runtime configuration tests.
