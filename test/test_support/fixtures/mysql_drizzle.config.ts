/**
 * Drizzle Kit config for `mysql_schema.ts` (the MySQL fixture). Migrations must not be created
 * or edited by hand (per AGENTS.md); regenerate them with `vp run test-fixtures:generate:mysql`.
 * `dbCredentials` is used only for generation (static analysis of the schema file only, no real
 * DB connection needed; a dummy value is passed, same as `pg_drizzle.config.ts`).
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "mysql",
	schema: "test/test_support/fixtures/mysql_schema.ts",
	out: "test/test_support/fixtures/mysql_migrations",
	dbCredentials: {
		host: "localhost",
		port: 3306,
		user: "unused",
		password: "unused",
		database: "unused",
	},
});
