/**
 * Verifies `SQLiteDatabaseKeyValueStore` (a `KeyValueStore` implementation
 * that injects an arbitrary table on top of Drizzle sqlite-core)
 * (docs/testing.md L1). Confirms round-trip, expiry, upsert, and delete using
 * `@libsql/client`'s `:memory:` and a minimal schema defined inline in the
 * test (not the app's `db/schema` or `test/helpers/`) — the same approach as
 * `test/session/sqlite_database_session_storage.test.ts`.
 */
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { SQLiteKeyValueRecordTable } from "../../src/kv/sqlite_database_key_value_store.js";
import { SQLiteDatabaseKeyValueStore } from "../../src/kv/sqlite_database_key_value_store.js";

/** Minimal test-only schema holding just the key/value/expiresAt columns that `SQLiteDatabaseKeyValueStore` requires. */
const entriesTable = sqliteTable("kv_entries", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at"),
}) satisfies SQLiteKeyValueRecordTable;

describe("SQLiteDatabaseKeyValueStore", () => {
	let client: Client;

	beforeEach(async () => {
		client = createClient({ url: ":memory:" });
		await client.execute(
			"CREATE TABLE kv_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(() => {
		client.close();
		vi.useRealTimers();
	});

	test("getting a key after set restores the same value", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");

		expect(await store.get("k1")).toBe("v1");
	});

	test("a nonexistent key returns null", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		expect(await store.get("unknown")).toBeNull();
	});

	test("getting after ttlSeconds elapses returns null and removes the row", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1", 60);
		vi.advanceTimersByTime(60_000 + 1);

		expect(await store.get("k1")).toBeNull();
		const rows = await client.execute("SELECT COUNT(*) as count FROM kv_entries");
		expect(rows.rows[0]?.count).toBe(0);
	});

	test("omitting ttlSeconds is treated as no expiry (expiresAt is null)", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);

		expect(await store.get("k1")).toBe("v1");
	});

	test("set overwrites an existing key (upsert adds no new row)", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		await store.set("k1", "v2");

		const rows = await client.execute("SELECT COUNT(*) as count FROM kv_entries");
		expect(rows.rows[0]?.count).toBe(1);
		expect(await store.get("k1")).toBe("v2");
	});

	test("delete removes the row, and subsequent get returns null", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);
		await store.set("k1", "v1");

		await store.delete("k1");

		expect(await store.get("k1")).toBeNull();
	});

	test("delete does not throw for a nonexistent key", async () => {
		const db = drizzle(client);
		const store = new SQLiteDatabaseKeyValueStore(db, entriesTable);

		await expect(store.delete("unknown")).resolves.toBeUndefined();
	});
});
