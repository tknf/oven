/**
 * Verifies `PgDatabaseKeyValueStore` (a `KeyValueStore` implementation that
 * injects an arbitrary table on top of Drizzle pg-core) (docs/testing.md L1).
 * Confirms the same aspects (round-trip, upsert, expiry, delete) as
 * `test/kv/sqlite_database_key_value_store.test.ts`, using PGlite (an
 * in-process WASM Postgres) and a minimal schema defined inline in the test
 * (not the app's `db/schema` or `test/helpers/`).
 */
import { PGlite } from "@electric-sql/pglite";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { PgKeyValueRecordTable } from "../../src/kv/pg_database_key_value_store.js";
import { PgDatabaseKeyValueStore } from "../../src/kv/pg_database_key_value_store.js";

/**
 * Minimal test-only schema holding just the key/value/expiresAt columns that
 * `PgDatabaseKeyValueStore` requires. `expiresAt` is an epoch ms value (needs
 * 64-bit precision), so `bigint(..., { mode: "number" })` is used (same reason
 * as `test/session/pg_database_session_storage.test.ts`).
 */
const entriesTable = pgTable("kv_entries", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }),
}) satisfies PgKeyValueRecordTable;

describe("PgDatabaseKeyValueStore", () => {
	let client: PGlite;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(
			"CREATE TABLE kv_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
	});

	afterEach(async () => {
		await client.close();
		vi.useRealTimers();
	});

	test("getting a key after set restores the same value", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");

		expect(await store.get("k1")).toBe("v1");
	});

	test("a nonexistent key returns null", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		expect(await store.get("unknown")).toBeNull();
	});

	test("getting after ttlSeconds elapses returns null and removes the row", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1", 60);
		vi.advanceTimersByTime(60_000 + 1);

		expect(await store.get("k1")).toBeNull();
		const rows = await client.query<{ count: number }>("SELECT COUNT(*) as count FROM kv_entries");
		expect(rows.rows[0]?.count).toBe(0);
	});

	test("omitting ttlSeconds is treated as no expiry (expiresAt is null)", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 365);

		expect(await store.get("k1")).toBe("v1");
	});

	test("set overwrites an existing key (upsert adds no new row)", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		await store.set("k1", "v1");
		await store.set("k1", "v2");

		const rows = await client.query<{ count: number }>("SELECT COUNT(*) as count FROM kv_entries");
		expect(rows.rows[0]?.count).toBe(1);
		expect(await store.get("k1")).toBe("v2");
	});

	test("delete removes the row, and subsequent get returns null", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);
		await store.set("k1", "v1");

		await store.delete("k1");

		expect(await store.get("k1")).toBeNull();
	});

	test("delete does not throw for a nonexistent key", async () => {
		const db = drizzle(client);
		const store = new PgDatabaseKeyValueStore(db, entriesTable);

		await expect(store.delete("unknown")).resolves.toBeUndefined();
	});
});
