/**
 * Verifies that the default schema factories for convention tables (`sqliteSessionsTable`/
 * `sqliteKeyValueTable`) work through `SQLiteDatabaseSessionStorage`/`SQLiteDatabaseKeyValueStore`
 * against tables actually migrated by `createTestDb` (`src/test/db.ts`).
 * `jobs`/`broadcasts` schemas produced by the factories are already exercised indirectly via
 * existing fixtures tests (e.g. `db.test.ts`), so they are not tested individually here.
 */
import { drizzle } from "drizzle-orm/libsql";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { SQLiteDatabaseKeyValueStore } from "../../src/kv/sqlite_database_key_value_store.js";
import { Session } from "../../src/session/session.js";
import { SQLiteDatabaseSessionStorage } from "../../src/session/sqlite_database_session_storage.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "./fixtures/schema.js";

const migrationsFolder = new URL("./fixtures/migrations", import.meta.url).pathname;

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe("default schema factory tables in practice (SQLite)", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("can commit then get round-trip on a table migrated via sqliteSessionsTable()", async () => {
		const { client } = await createTestDb({ schema, migrationsFolder });
		cleanup = () => client.close();
		const storage = new SQLiteDatabaseSessionStorage(drizzle(client), schema.sessions);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("can set, get, and delete on a table migrated via sqliteKeyValueTable()", async () => {
		const { client } = await createTestDb({ schema, migrationsFolder });
		cleanup = () => client.close();
		const store = new SQLiteDatabaseKeyValueStore(drizzle(client), schema.kvEntries);

		await store.set("k1", "v1");
		expect(await store.get("k1")).toBe("v1");

		await store.delete("k1");
		expect(await store.get("k1")).toBeNull();
	});
});
