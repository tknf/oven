/**
 * Verifies that the default schema factories for convention tables (`mysqlSessionsTable`/
 * `mysqlKeyValueTable`) work through `MySqlDatabaseSessionStorage`/`MySqlDatabaseKeyValueStore`
 * against a real MySQL server (Docker). Uses the same gate as
 * `test/session/mysql_database_session_storage.test.ts` (skipped via `describe.skipIf` when the
 * `OVEN_MYSQL_TEST_URL` environment variable is unset).
 * `jobs`/`broadcasts` are already exercised by existing fixtures tests, so they are not tested
 * individually here.
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/test_support/mysql_default_tables.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection } from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
	MySqlDatabaseKeyValueStore,
	mysqlKeyValueTable,
} from "../../src/kv/mysql_database_key_value_store.js";
import {
	MySqlDatabaseSessionStorage,
	mysqlSessionsTable,
} from "../../src/session/mysql_database_session_storage.js";
import { Session } from "../../src/session/session.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;

const sessionsTable = mysqlSessionsTable();
const kvEntriesTable = mysqlKeyValueTable();

const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

describe.skipIf(!OVEN_MYSQL_TEST_URL)("default schema factory tables in practice (MySQL)", () => {
	let connection: Connection;

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		connection = await createConnection(OVEN_MYSQL_TEST_URL);
		await connection.query("DROP TABLE IF EXISTS sessions");
		await connection.query("DROP TABLE IF EXISTS kv_entries");
		await connection.query(
			"CREATE TABLE sessions (id VARCHAR(255) PRIMARY KEY, data TEXT NOT NULL, expires_at BIGINT NOT NULL)",
		);
		await connection.query(
			"CREATE TABLE kv_entries (`key` VARCHAR(255) PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)",
		);
	});

	afterEach(async () => {
		await connection.end();
	});

	test("can commit then get round-trip on a table created via mysqlSessionsTable()", async () => {
		const db = drizzle(connection, { mode: "default" });
		const storage = new MySqlDatabaseSessionStorage(db, sessionsTable);
		const session = new Session("");
		session.set("userId", "u_1");

		const setCookie = await storage.commit(session);
		const restored = await storage.get(toCookieHeader(setCookie));

		expect(restored.get("userId")).toBe("u_1");
	});

	test("can set, get, and delete on a table created via mysqlKeyValueTable()", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, kvEntriesTable);

		await store.set("k1", "v1");
		expect(await store.get("k1")).toBe("v1");

		await store.delete("k1");
		expect(await store.get("k1")).toBeNull();
	});
});
