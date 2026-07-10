/**
 * Verifies `SQLitePruneExpiredRecordsJob` (a `Job` that batch-deletes expired
 * rows from one or more Drizzle sqlite-core tables shaped like the
 * `KeyValueStore`/`SessionStorage` DB-backed families;
 * `src/jobs/sqlite_prune_expired_records_job.ts`) (docs/testing.md L1). Uses
 * `@libsql/client`'s `:memory:` and two minimal schemas defined inline in
 * the test (a KV-shaped table with nullable `expiresAt`, and a
 * session-shaped table with `NOT NULL expiresAt`) — the same technique as
 * `test/kv/sqlite_database_key_value_store.test.ts` and
 * `test/session/sqlite_database_session_storage.test.ts`.
 */
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { SQLitePruneTarget } from "../../src/jobs/sqlite_prune_expired_records_job.js";
import { SQLitePruneExpiredRecordsJob } from "../../src/jobs/sqlite_prune_expired_records_job.js";

/** A KV-shaped table (nullable `expiresAt`, primary key `key`), matching `SQLiteKeyValueRecordTable`. */
const kvEntries = sqliteTable("kv_entries", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at"),
});

/** A session-shaped table (`NOT NULL expiresAt`, primary key `id`), matching `SQLiteSessionRecordTable`. */
const sessions = sqliteTable("sessions", {
	id: text("id").primaryKey(),
	data: text("data").notNull(),
	expiresAt: integer("expires_at").notNull(),
});

describe("SQLitePruneExpiredRecordsJob", () => {
	let client: Client;

	beforeEach(async () => {
		client = createClient({ url: ":memory:" });
		await client.execute(
			"CREATE TABLE kv_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)",
		);
		await client.execute(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at INTEGER NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
	});

	afterEach(() => {
		client.close();
		vi.useRealTimers();
	});

	test("default name is oven:prune_expired_records", () => {
		const db = drizzle(client);
		const job = new SQLitePruneExpiredRecordsJob(db, []);

		expect(job.name).toBe("oven:prune_expired_records");
	});

	test("a custom name overrides the default", () => {
		const db = drizzle(client);
		const job = new SQLitePruneExpiredRecordsJob(db, [], { name: "custom:prune" });

		expect(job.name).toBe("custom:prune");
	});

	test("deletes only rows whose expiresAt has already passed, leaving future rows and NULL (never-expiring) rows untouched", async () => {
		const db = drizzle(client);
		const now = Date.now();
		await db.insert(kvEntries).values([
			{ key: "expired", value: "v1", expiresAt: now - 1000 },
			{ key: "future", value: "v2", expiresAt: now + 1000 },
			{ key: "no-ttl", value: "v3", expiresAt: null },
		]);
		const target: SQLitePruneTarget = {
			table: kvEntries,
			pkColumn: kvEntries.key,
			expiresAtColumn: kvEntries.expiresAt,
		};
		const job = new SQLitePruneExpiredRecordsJob(db, [target]);

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining.map((row) => row.key).sort()).toEqual(["future", "no-ttl"]);
	});

	test("sweeps every target in the targets array, across differently-shaped tables in one call", async () => {
		const db = drizzle(client);
		const now = Date.now();
		await db.insert(kvEntries).values([{ key: "expired-kv", value: "v1", expiresAt: now - 1000 }]);
		await db
			.insert(sessions)
			.values([{ id: "expired-session", data: "{}", expiresAt: now - 1000 }]);
		const job = new SQLitePruneExpiredRecordsJob(db, [
			{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt },
			{ table: sessions, pkColumn: sessions.id, expiresAtColumn: sessions.expiresAt },
		]);

		await job.perform();

		expect(await db.select().from(kvEntries)).toEqual([]);
		expect(await db.select().from(sessions)).toEqual([]);
	});

	test("repeats select-then-delete across multiple batches until every expired row is gone", async () => {
		const db = drizzle(client);
		const now = Date.now();
		await db.insert(kvEntries).values(
			Array.from({ length: 12 }, (_, i) => ({
				key: `expired-${i}`,
				value: "v",
				expiresAt: now - 1000,
			})),
		);
		const job = new SQLitePruneExpiredRecordsJob(
			db,
			[{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt }],
			{ batchSize: 5 },
		);

		await job.perform();

		expect(await db.select().from(kvEntries)).toEqual([]);
	});

	test("maxBatches caps the number of batches processed per target, leaving the remainder for the next run", async () => {
		const db = drizzle(client);
		const now = Date.now();
		await db.insert(kvEntries).values(
			Array.from({ length: 12 }, (_, i) => ({
				key: `expired-${i}`,
				value: "v",
				expiresAt: now - 1000,
			})),
		);
		const job = new SQLitePruneExpiredRecordsJob(
			db,
			[{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt }],
			{ batchSize: 5, maxBatches: 1 },
		);

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining).toHaveLength(7);
	});
});
