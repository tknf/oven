# Testing oven applications

`@tknf/oven/test` provides `createTestDb({ schema, migrationsFolder })` (throwaway
libSQL DB), `defineFactory(persist, defaults)`, `actingAs(storage, { identityKey,
identity })` (auth cookie), and `TestJobQueue`/`TestMailer`/`TestBroadcaster`
(record instead of performing) — the fakes still run real validation, and
`TestBroadcaster` also delivers to its own `subscribe`d listeners like
`InMemoryBroadcaster`. Drive the app via `app.request(...)`.
