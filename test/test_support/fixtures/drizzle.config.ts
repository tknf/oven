/**
 * Drizzle Kit config for the fixture used to verify `createTestDb` (`src/test/db.ts`).
 * Migrations must not be created or edited by hand; regenerate them with
 * `vp exec drizzle-kit generate --config=test/test_support/fixtures/drizzle.config.ts`.
 * `dbCredentials` is a dummy value used only for generation (no actual DB connection needed).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "turso",
	schema: "test/test_support/fixtures/schema.ts",
	out: "test/test_support/fixtures/migrations",
	dbCredentials: {
		url: "file:unused.sqlite",
	},
});
