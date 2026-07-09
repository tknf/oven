/**
 * Verifies `MySqlDatabaseKeyValueStore` (a `KeyValueStore` implementation that
 * injects an arbitrary table on top of Drizzle mysql-core) (docs/testing.md
 * L1). Confirms the same aspects (round-trip, upsert, expiry, delete) as
 * `test/kv/sqlite_database_key_value_store.test.ts` and
 * `test/kv/pg_database_key_value_store.test.ts`, but against a real MySQL
 * server (Docker).
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is unset, every test in
 * this file is skipped via `describe.skipIf` (the same gate as
 * `test/session/mysql_database_session_storage.test.ts`).
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/kv/mysql_database_key_value_store.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection } from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { MySqlKeyValueRecordTable } from "../../src/kv/mysql_database_key_value_store.js";
import { MySqlDatabaseKeyValueStore } from "../../src/kv/mysql_database_key_value_store.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;

/**
 * Minimal test-only schema holding just the key/value/expiresAt columns that
 * `MySqlDatabaseKeyValueStore` requires. `expiresAt` is an epoch ms value (needs
 * 64-bit precision), so `bigint(..., { mode: "number" })` is used (same reason
 * as `test/session/mysql_database_session_storage.test.ts`).
 */
const entriesTable = mysqlTable("kv_entries", {
	key: varchar("key", { length: 255 }).primaryKey(),
	value: varchar("value", { length: 4096 }).notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }),
}) satisfies MySqlKeyValueRecordTable;

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlDatabaseKeyValueStore", () => {
	let connection: Connection;

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		connection = await createConnection(OVEN_MYSQL_TEST_URL);
		await connection.query("DROP TABLE IF EXISTS kv_entries");
		await connection.query(
			"CREATE TABLE kv_entries (`key` VARCHAR(255) PRIMARY KEY, value VARCHAR(4096) NOT NULL, expires_at BIGINT)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(async () => {
		await connection.end();
		vi.useRealTimers();
	});

	test("getting a key after set restores the same value", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");

		expect(await store.get("k1")).toBe("v1");
	});

	test("a nonexistent key returns null", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		expect(await store.get("unknown")).toBeNull();
	});

	test("getting after ttlSeconds elapses returns null and removes the row", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1", 60);
		vi.advanceTimersByTime(60_000 + 1);

		expect(await store.get("k1")).toBeNull();
		const [rows] = await connection.query("SELECT COUNT(*) as count FROM kv_entries");
		const [row] = rows as Array<{ count: number }>;
		expect(row?.count).toBe(0);
	});

	test("omitting ttlSeconds is treated as no expiry (expiresAt is null)", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);

		expect(await store.get("k1")).toBe("v1");
	});

	test("set overwrites an existing key (upsert adds no new row)", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		await store.set("k1", "v2");

		const [rows] = await connection.query("SELECT COUNT(*) as count FROM kv_entries");
		const [row] = rows as Array<{ count: number }>;
		expect(row?.count).toBe(1);
		expect(await store.get("k1")).toBe("v2");
	});

	test("delete removes the row, and subsequent get returns null", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);
		await store.set("k1", "v1");

		await store.delete("k1");

		expect(await store.get("k1")).toBeNull();
	});

	test("delete does not throw for a nonexistent key", async () => {
		const db = drizzle(connection, { mode: "default" });
		const store = new MySqlDatabaseKeyValueStore(db, entriesTable);

		await expect(store.delete("unknown")).resolves.toBeUndefined();
	});
});
