/**
 * Verifies `MySqlPruneExpiredRecordsJob` (the MySQL variant of a `Job` that
 * batch-deletes expired rows from one or more Drizzle mysql-core tables
 * shaped like the `KeyValueStore`/`SessionStorage` DB-backed families;
 * `src/jobs/mysql_prune_expired_records_job.ts`) (docs/testing.md L1).
 * Checks the same aspects as
 * `test/jobs/sqlite_prune_expired_records_job.test.ts` and
 * `test/jobs/pg_prune_expired_records_job.test.ts`, but against a real
 * MySQL server (Docker).
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is not set, all tests in
 * this file are skipped via `describe.skipIf` (same gate as
 * `test/kv/mysql_database_key_value_store.test.ts`).
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test run test/jobs/mysql_prune_expired_records_job.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { eq } from "drizzle-orm";
import { bigint, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import { drizzle } from "drizzle-orm/mysql2";
import { createConnection } from "mysql2/promise";
import type { Connection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { MySqlPruneTarget } from "../../src/jobs/mysql_prune_expired_records_job.js";
import { MySqlPruneExpiredRecordsJob } from "../../src/jobs/mysql_prune_expired_records_job.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;

/** A KV-shaped table (nullable `expiresAt`, primary key `key`), matching `MySqlKeyValueRecordTable`. */
const kvEntries = mysqlTable("kv_entries", {
	key: varchar("key", { length: 255 }).primaryKey(),
	value: varchar("value", { length: 4096 }).notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }),
});

/** A session-shaped table (`NOT NULL expiresAt`, primary key `id`), matching `MySqlSessionRecordTable`. */
const sessions = mysqlTable("sessions", {
	id: varchar("id", { length: 255 }).primaryKey(),
	data: varchar("data", { length: 4096 }).notNull(),
	expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlPruneExpiredRecordsJob", () => {
	let connection: Connection;

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		connection = await createConnection(OVEN_MYSQL_TEST_URL);
		await connection.query("DROP TABLE IF EXISTS kv_entries");
		await connection.query("DROP TABLE IF EXISTS sessions");
		await connection.query(
			"CREATE TABLE kv_entries (`key` VARCHAR(255) PRIMARY KEY, value VARCHAR(4096) NOT NULL, expires_at BIGINT)",
		);
		await connection.query(
			"CREATE TABLE sessions (id VARCHAR(255) PRIMARY KEY, data VARCHAR(4096) NOT NULL, expires_at BIGINT NOT NULL)",
		);
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
	});

	afterEach(async () => {
		await connection.end();
		vi.useRealTimers();
	});

	test("default name is oven:prune_expired_records", () => {
		const db = drizzle(connection, { mode: "default" });
		const job = new MySqlPruneExpiredRecordsJob(db, []);

		expect(job.name).toBe("oven:prune_expired_records");
	});

	test("deletes only rows whose expiresAt has already passed, leaving future rows and NULL (never-expiring) rows untouched", async () => {
		const db = drizzle(connection, { mode: "default" });
		const now = Date.now();
		await db.insert(kvEntries).values([
			{ key: "expired", value: "v1", expiresAt: now - 1000 },
			{ key: "future", value: "v2", expiresAt: now + 1000 },
			{ key: "no-ttl", value: "v3", expiresAt: null },
		]);
		const target: MySqlPruneTarget = {
			table: kvEntries,
			pkColumn: kvEntries.key,
			expiresAtColumn: kvEntries.expiresAt,
		};
		const job = new MySqlPruneExpiredRecordsJob(db, [target]);

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining.map((row) => row.key).sort()).toEqual(["future", "no-ttl"]);
	});

	test("sweeps every target in the targets array, across differently-shaped tables in one call", async () => {
		const db = drizzle(connection, { mode: "default" });
		const now = Date.now();
		await db.insert(kvEntries).values([{ key: "expired-kv", value: "v1", expiresAt: now - 1000 }]);
		await db
			.insert(sessions)
			.values([{ id: "expired-session", data: "{}", expiresAt: now - 1000 }]);
		const job = new MySqlPruneExpiredRecordsJob(db, [
			{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt },
			{ table: sessions, pkColumn: sessions.id, expiresAtColumn: sessions.expiresAt },
		]);

		await job.perform();

		expect(await db.select().from(kvEntries)).toEqual([]);
		expect(await db.select().from(sessions)).toEqual([]);
	});

	test("repeats select-then-delete across multiple batches until every expired row is gone", async () => {
		const db = drizzle(connection, { mode: "default" });
		const now = Date.now();
		await db.insert(kvEntries).values(
			Array.from({ length: 12 }, (_, i) => ({
				key: `expired-${i}`,
				value: "v",
				expiresAt: now - 1000,
			})),
		);
		const job = new MySqlPruneExpiredRecordsJob(
			db,
			[{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt }],
			{ batchSize: 5 },
		);

		await job.perform();

		expect(await db.select().from(kvEntries)).toEqual([]);
	});

	test("maxBatches caps the number of batches processed per target, leaving the remainder for the next run", async () => {
		const db = drizzle(connection, { mode: "default" });
		const now = Date.now();
		await db.insert(kvEntries).values(
			Array.from({ length: 12 }, (_, i) => ({
				key: `expired-${i}`,
				value: "v",
				expiresAt: now - 1000,
			})),
		);
		const job = new MySqlPruneExpiredRecordsJob(
			db,
			[{ table: kvEntries, pkColumn: kvEntries.key, expiresAtColumn: kvEntries.expiresAt }],
			{ batchSize: 5, maxBatches: 1 },
		);

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining).toHaveLength(7);
	});

	test("a row renewed between the SELECT and DELETE phases survives, even though it was already selected as expired (issue #60)", async () => {
		const db = drizzle(connection, { mode: "default" });
		const now = Date.now();
		await db.insert(kvEntries).values([
			{ key: "renewed", value: "v1", expiresAt: now - 1000 },
			{ key: "stays-expired", value: "v2", expiresAt: now - 1000 },
		]);
		const target: MySqlPruneTarget = {
			table: kvEntries,
			pkColumn: kvEntries.key,
			expiresAtColumn: kvEntries.expiresAt,
		};
		const job = new MySqlPruneExpiredRecordsJob(db, [target]);

		/*
		 * Deterministically reproduce the race without real concurrency: the
		 * job's SELECT phase has already read "renewed" as expired by the
		 * time `perform()` is called. `db.delete(table).where(...)` mutates
		 * and returns the same builder instance (see
		 * drizzle-orm/mysql-core's `MySqlDeleteBase.where`), and that
		 * instance's `execute` is what actually issues the DELETE, so
		 * patching `execute` lets us land a renewal -- the same
		 * PK-preserving upsert
		 * `MySqlDatabaseKeyValueStore.set`/`MySqlDatabaseSessionStorage.commit`
		 * use to extend `expiresAt` -- in the exact window between the
		 * SELECT and the DELETE.
		 */
		const originalDelete = db.delete.bind(db);
		vi.spyOn(db, "delete").mockImplementation((table) => {
			const deleteBuilder = originalDelete(table);
			const originalExecute = deleteBuilder.execute.bind(deleteBuilder);
			deleteBuilder.execute = async () => {
				await db
					.update(kvEntries)
					.set({ expiresAt: now + 60_000 })
					.where(eq(kvEntries.key, "renewed"));
				return originalExecute();
			};
			return deleteBuilder;
		});

		await job.perform();

		const remaining = await db.select({ key: kvEntries.key }).from(kvEntries);
		expect(remaining.map((row) => row.key)).toEqual(["renewed"]);
	});
});
