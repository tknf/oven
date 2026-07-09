/**
 * Verifies `MySqlJobsConsole` (the MySQL variant of the operational console for
 * the `jobs` table; `src/jobs/mysql_jobs_console.ts`). Checks the same aspects as
 * `test/jobs/sqlite_jobs_console.test.ts` against an actual MySQL server (Docker)
 * plus the `jobs` table from `test/test_support/fixtures/mysql_schema.ts` and
 * `mysql_migrations`.
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is unset, every test in this
 * file is skipped via `describe.skipIf` (the same gate as
 * `test/jobs/mysql_database_job_worker.test.ts`).
 *
 * ## Local run instructions
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/jobs/mysql_jobs_console.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MySqlJobsConsole } from "../../src/jobs/mysql_jobs_console.js";
import * as schema from "../test_support/fixtures/mysql_schema.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;
const migrationsFolder = new URL("../test_support/fixtures/mysql_migrations", import.meta.url)
	.pathname;

/** Override values passed to insertJob. Columns other than the NOT NULL ones (name/payload) have defaults. */
type JobOverrides = Partial<typeof schema.jobs.$inferInsert> &
	Pick<typeof schema.jobs.$inferInsert, "name" | "payload">;

/**
 * Connects, applies migrations, and clears any `jobs` rows left by the previous
 * test before returning. Other tables like `publishers` aren't touched since this
 * file doesn't use them.
 */
const createTestDb = async (url: string) => {
	const connection = await createConnection(url);
	const db = drizzle(connection, { schema, mode: "default" });
	await migrate(db, { migrationsFolder });
	await connection.query("DELETE FROM jobs");
	return { connection, db };
};

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlJobsConsole", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb>>;

	/** Inserts a single row into the `jobs` table and returns its id. Unspecified columns are filled with initial-state values. */
	const insertJob = async (overrides: JobOverrides): Promise<string> => {
		const id = overrides.id ?? randomUUID();
		const now = Date.now();
		await ctx.db.insert(schema.jobs).values({
			id,
			name: overrides.name,
			payload: overrides.payload,
			runAt: overrides.runAt ?? now,
			priority: overrides.priority ?? 0,
			attempts: overrides.attempts ?? 0,
			lockedAt: overrides.lockedAt ?? null,
			failedAt: overrides.failedAt ?? null,
			lastError: overrides.lastError ?? null,
			createdAt: overrides.createdAt ?? now,
		});
		return id;
	};

	const retrieveJob = async (id: string) => {
		const [row] = await ctx.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
		return row;
	};

	beforeEach(async () => {
		if (!OVEN_MYSQL_TEST_URL) throw new Error("OVEN_MYSQL_TEST_URL is not set");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		ctx = await createTestDb(OVEN_MYSQL_TEST_URL);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await ctx.connection.end();
	});

	test("listPending returns only non-failed rows, ordered by priority ascending, then runAt ascending within the same priority", async () => {
		const now = Date.now();
		await insertJob({
			name: "greet",
			payload: "{}",
			runAt: now - 1000,
			priority: 0,
		});
		await insertJob({
			name: "greet",
			payload: "{}",
			runAt: now - 2000,
			priority: -1,
		});
		await insertJob({
			name: "greet",
			payload: "{}",
			failedAt: now,
		});

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const rows = await console.listPending();

		expect(rows).toHaveLength(2);
		expect(rows[0]?.priority).toBe(-1);
		expect(rows[1]?.priority).toBe(0);
	});

	test("listPending clamps to MAX_LIST_LIMIT (1000) even if limit exceeds it", async () => {
		const now = Date.now();
		const rowCount = 1005;
		const chunkSize = 100;
		for (let offset = 0; offset < rowCount; offset += chunkSize) {
			const chunk = Array.from({ length: Math.min(chunkSize, rowCount - offset) }, (_, i) => ({
				id: randomUUID(),
				name: "greet",
				payload: "{}",
				runAt: now - (offset + i),
				priority: 0,
				attempts: 0,
				lockedAt: null,
				failedAt: null,
				lastError: null,
				createdAt: now,
			}));
			await ctx.db.insert(schema.jobs).values(chunk);
		}

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const rows = await console.listPending(1_000_000);

		expect(rows).toHaveLength(1000);
	});

	test("listFailed returns only failed rows, ordered by failedAt descending", async () => {
		const now = Date.now();
		await insertJob({ name: "greet", payload: "{}" });
		const olderFailure = await insertJob({
			name: "fail",
			payload: "{}",
			failedAt: now - 1000,
		});
		const newerFailure = await insertJob({
			name: "fail",
			payload: "{}",
			failedAt: now,
		});

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const rows = await console.listFailed();

		expect(rows.map((row) => row.id)).toEqual([newerFailure, olderFailure]);
	});

	test("retryFailed resets a confirmed-failed row to failedAt/lastError/lockedAt null, attempts 0, runAt now, and returns true", async () => {
		const id = await insertJob({
			name: "fail",
			payload: "{}",
			attempts: 3,
			failedAt: Date.now() - 5000,
			lastError: "Error: permanent failure",
			lockedAt: Date.now() - 5000,
		});

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const retried = await console.retryFailed(id);

		expect(retried).toBe(true);
		const row = await retrieveJob(id);
		expect(row).toMatchObject({
			failedAt: null,
			lastError: null,
			attempts: 0,
			lockedAt: null,
			runAt: Date.now(),
		});
	});

	test("retryFailed returns false and leaves a non-failed row unchanged", async () => {
		const id = await insertJob({ name: "greet", payload: "{}" });

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const retried = await console.retryFailed(id);

		expect(retried).toBe(false);
		const row = await retrieveJob(id);
		expect(row?.failedAt).toBeNull();
	});

	test("retryFailed returns false for a nonexistent id", async () => {
		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const retried = await console.retryFailed(randomUUID());

		expect(retried).toBe(false);
	});

	test("deleteJob deletes an existing row and returns true", async () => {
		const id = await insertJob({ name: "greet", payload: "{}" });

		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const deleted = await console.deleteJob(id);

		expect(deleted).toBe(true);
		expect(await retrieveJob(id)).toBeUndefined();
	});

	test("deleteJob returns false for a nonexistent id", async () => {
		const console = new MySqlJobsConsole(ctx.db, schema.jobs);
		const deleted = await console.deleteJob(randomUUID());

		expect(deleted).toBe(false);
	});
});
