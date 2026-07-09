/**
 * Verifies that `test/test_support/fixtures/pg_schema.ts` and `pg_migrations` (the Postgres
 * fixtures) work as an actual migration path. Confirms the same aspect as
 * `test/test_support/db.test.ts` (verification of the SQLite `createTestDb`) — that
 * migration application followed by INSERT/SELECT succeeds — using PGlite
 * (`@electric-sql/pglite`) + `drizzle-orm/pglite/migrator`.
 *
 * `createTestDb` in `src/test/db.ts` is libSQL-only (fixed to the Node `@libsql/client`), and
 * an equivalent Postgres helper is out of scope for this task (no addition to `src/test/` here).
 * This test is limited to guaranteeing that the fixtures themselves (`pg_schema.ts`,
 * `pg_migrations`) are actually exercised and the migration path is verified.
 *
 * Also confirms that writing an epoch ms value (`Date.now()`) to `createdAt` does not trigger
 * `out of range for type integer` when the Postgres `bigint` column uses `{ mode: "number" }`
 * (see the module JSDoc in `pg_schema.ts`).
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, test } from "vite-plus/test";
import * as schema from "./fixtures/pg_schema.js";

const migrationsFolder = new URL("./fixtures/pg_migrations", import.meta.url).pathname;

describe("Postgres fixtures (pg_schema.ts / pg_migrations)", () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test("applies migrations and can INSERT/SELECT a row containing epoch ms on a known table", async () => {
		const client = new PGlite();
		cleanup = () => client.close();
		const db = drizzle(client, { schema });
		await migrate(db, { migrationsFolder });

		const publisher = {
			id: "publisher-1",
			name: "Test Publisher",
			contactEmail: "publisher@example.com",
			status: "active",
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};
		await db.insert(schema.publishers).values(publisher);

		const [found] = await db
			.select()
			.from(schema.publishers)
			.where(eq(schema.publishers.id, publisher.id));

		expect(found?.name).toBe("Test Publisher");
		expect(found?.createdAt).toBe(publisher.createdAt);
	});
});
