/**
 * Drizzle Kit config for `pg_schema.ts` (the Postgres fixture). Migrations must not be created
 * or edited by hand (per AGENTS.md); regenerate them with `vp run test-fixtures:generate:pg`.
 * `driver: "pglite"` is a PGlite-only generate mode (completes without a DB connection; the
 * `dialect: "postgresql"` + `driver: "pglite"` combination was confirmed against
 * `node_modules/drizzle-kit/index.d.mts`).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	driver: "pglite",
	schema: "test/test_support/fixtures/pg_schema.ts",
	out: "test/test_support/fixtures/pg_migrations",
	dbCredentials: {
		url: "unused",
	},
});
