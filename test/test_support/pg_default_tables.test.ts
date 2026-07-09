/**
 * Verifies that the default schema factories for convention tables (`pgSessionsTable`/
 * `pgKeyValueTable`) work through `PgDatabaseSessionStorage`/`PgDatabaseKeyValueStore` against
 * tables actually migrated via `pg_migrations` (the Postgres fixtures). This extends the same
 * verification as `test/test_support/pg_db.test.ts` (confirming the migration path with PGlite +
 * `drizzle-orm/pglite/migrator`) to cover the convention tables in practice. `jobs`/`broadcasts`
 * are already exercised by existing fixtures tests, so they are not tested individually here.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { PgDatabaseKeyValueStore } from "../../src/kv/pg_database_key_value_store.js";
import { Session } from "../../src/session/session.js";
import { PgDatabaseSessionStorage } from "../../src/session/pg_database_session_storage.js";
import * as schema from "./fixtures/pg_schema.js";

const migrationsFolder = new URL("./fixtures/pg_migrations", import.meta.url).pathname;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("default schema factory tables in practice (Postgres)", () => {
	let cleanup: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
	});

	test("can commit then get round-trip on a table migrated via pgSessionsTable()", async () => {
		const client = new PGlite();
		cleanup = () => client.close();
		const migratorDb = drizzle(client, { schema });
		await migrate(migratorDb, { migrationsFolder });
		const db = drizzle(client);
		const storage = new PgDatabaseSessionStorage(db, schema.sessions);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("can set, get, and delete on a table migrated via pgKeyValueTable()", async () => {
		const client = new PGlite();
		cleanup = () => client.close();
		const migratorDb = drizzle(client, { schema });
		await migrate(migratorDb, { migrationsFolder });
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, schema.kvEntries);

		await store.set("k1", "v1");
		expect(await store.get("k1")).toBe("v1");

		await store.delete("k1");
		expect(await store.get("k1")).toBeNull();
	});
});
