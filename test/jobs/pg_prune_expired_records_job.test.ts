/**
 * Verifies `PgPruneExpiredRecordsJob` (the Postgres variant of a `Job` that
 * batch-deletes expired rows from one or more Drizzle pg-core tables shaped
 * like the `KeyValueStore`/`SessionStorage` DB-backed families;
 * `src/jobs/pg_prune_expired_records_job.ts`) (docs/testing.md L1). Checks
 * the same aspects as `test/jobs/sqlite_prune_expired_records_job.test.ts`
 * against PGlite (an in-process WASM Postgres) and two minimal schemas
 * defined inline in the test — the same technique as
 * `test/kv/pg_database_key_value_store.test.ts` and
 * `test/session/pg_database_session_storage.test.ts`.
 */
import { PGlite } from "@electric-sql/pglite";
import { bigint, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { PgPruneTarget } from "../../src/jobs/pg_prune_expired_records_job.js";
import { PgPruneExpiredRecordsJob } from "../../src/jobs/pg_prune_expired_records_job.js";

/** A KV-shaped table (nullable `expiresAt`, primary key `key`), matching `PgKeyValueRecordTable`. */
const kvEntries = pgTable("kv_entries", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }),
});

/** A session-shaped table (`NOT NULL expiresAt`, primary key `id`), matching `PgSessionRecordTable`. */
const sessions = pgTable("sessions", {
	id: text("id").primaryKey(),
	data: text("data").notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

describe("PgPruneExpiredRecordsJob", () => {
	let client: PGlite;

	beforeEach(async () => {
		client = new PGlite();
		await client.exec(
			"CREATE TABLE kv_entries (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at BIGINT)",
		);
		await client.exec(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires_at BIGINT NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
	});

	afterEach(async () => {
		await client.close();
		vi.useRealTimers();
	});

	test("default name is oven:prune_expired_records", () => {
		const db = drizzle(client);
		const job = new PgPruneExpiredRecordsJob(db, []);

		expect(job.name).toBe("oven:prune_expired_records");
	});

	test("a custom name overrides the default", () => {
		const db = drizzle(client);
		const job = new PgPruneExpiredRecordsJob(db, [], { name: "custom:prune" });

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
		const target: PgPruneTarget = {
			table: kvEntries,
			pkColumn: kvEntries.key,
			expiresAtColumn: kvEntries.expiresAt,
		};
		const job = new PgPruneExpiredRecordsJob(db, [target]);

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
		const job = new PgPruneExpiredRecordsJob(db, [
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
		const job = new PgPruneExpiredRecordsJob(
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
		const job = new PgPruneExpiredRecordsJob(
			db,
			[{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt }],
			{ batchSize: 5, maxBatches: 1 },
		);

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining).toHaveLength(7);
	});
});
