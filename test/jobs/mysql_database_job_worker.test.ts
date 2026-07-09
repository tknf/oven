/**
 * Verifies `MySqlDatabaseJobWorker` (the MySQL variant of the consumer side that
 * backs the queue with the relational database alone; `src/jobs/
 * mysql_database_job_worker.ts`). Checks the same aspects as
 * `test/jobs/sqlite_database_job_worker.test.ts` against an actual MySQL server
 * (Docker) plus the `jobs` table from `test/test_support/fixtures/mysql_schema.ts`
 * and `mysql_migrations`.
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is unset, every test in this
 * file is skipped via `describe.skipIf` (the same gate as
 * `test/model/mysql_model.test.ts`).
 *
 * ## Local run instructions
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/jobs/mysql_database_job_worker.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Job } from "../../src/jobs/job.js";
import { JobRegistry } from "../../src/jobs/job_registry.js";
import { MySqlDatabaseJobWorker } from "../../src/jobs/mysql_database_job_worker.js";
import * as schema from "../test_support/fixtures/mysql_schema.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;
const migrationsFolder = new URL("../test_support/fixtures/mysql_migrations", import.meta.url)
	.pathname;

type GreetJobPayload = { name: string };

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

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlDatabaseJobWorker", () => {
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

	test("performs a runnable row, and on success deletes the row and returns the count processed", async () => {
		const calls: GreetJobPayload[] = [];
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(payload: GreetJobPayload): Promise<void> {
				calls.push(payload);
			}
		}
		const registry = new JobRegistry();
		registry.register(new GreetJob());
		const id = await insertJob({ name: "greet", payload: JSON.stringify({ name: "Taro" }) });

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const processed = await worker.runOnce();

		expect(processed).toBe(1);
		expect(calls).toEqual([{ name: "Taro" }]);
		expect(await retrieveJob(id)).toBeUndefined();
	});

	test("a row whose runAt is in the future isn't processed", async () => {
		const registry = new JobRegistry();
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(): Promise<void> {}
		}
		registry.register(new GreetJob());
		const id = await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "Taro" }),
			runAt: Date.now() + 60_000,
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const processed = await worker.runOnce();

		expect(processed).toBe(0);
		expect(await retrieveJob(id)).toMatchObject({ lockedAt: null });
	});

	test("when perform fails, attempts increases, and if below maxAttempts, runAt advances by the backoff and lockedAt returns to null", async () => {
		const registry = new JobRegistry();
		class FailingJob extends Job<GreetJobPayload> {
			readonly name = "fail";
			async perform(): Promise<void> {
				throw new Error("transient failure");
			}
		}
		registry.register(new FailingJob());
		const onJobError = vi.fn();
		const id = await insertJob({ name: "fail", payload: JSON.stringify({ name: "Taro" }) });

		const worker = new MySqlDatabaseJobWorker(
			ctx.db,
			schema.jobs,
			registry,
			{ maxAttempts: 5, backoffSeconds: (attempt) => attempt * 10 },
			{ onJobError },
		);
		const processed = await worker.runOnce();

		expect(processed).toBe(1);
		expect(onJobError).toHaveBeenCalledWith("fail", expect.any(Error));
		const row = await retrieveJob(id);
		expect(row?.attempts).toBe(1);
		expect(row?.lockedAt).toBeNull();
		expect(row?.failedAt).toBeNull();
		expect(row?.runAt).toBe(Date.now() + 10_000);
	});

	test("upon reaching maxAttempts, failedAt/lastError are set and the row is no longer processed by runOnce", async () => {
		const registry = new JobRegistry();
		class FailingJob extends Job<GreetJobPayload> {
			readonly name = "fail";
			async perform(): Promise<void> {
				throw new Error("permanent failure");
			}
		}
		registry.register(new FailingJob());
		const id = await insertJob({
			name: "fail",
			payload: JSON.stringify({ name: "Taro" }),
			attempts: 2,
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry, { maxAttempts: 3 });
		const processed = await worker.runOnce();

		expect(processed).toBe(1);
		const row = await retrieveJob(id);
		expect(row?.attempts).toBe(3);
		expect(row?.failedAt).toBe(Date.now());
		expect(row?.lastError).toBe("Error: permanent failure");

		const second = await worker.runOnce();
		expect(second).toBe(0);
	});

	test("an unregistered job name sets failedAt, fires onUnknownJob, and doesn't retry", async () => {
		const registry = new JobRegistry();
		const onUnknownJob = vi.fn();
		const id = await insertJob({
			name: "not_registered",
			payload: JSON.stringify({}),
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry, {}, { onUnknownJob });
		const processed = await worker.runOnce();

		expect(processed).toBe(1);
		expect(onUnknownJob).toHaveBeenCalledWith("not_registered");
		const row = await retrieveJob(id);
		expect(row?.failedAt).toBe(Date.now());
		expect(row?.attempts).toBe(0);

		const second = await worker.runOnce();
		expect(second).toBe(0);
	});

	test("a row whose lockedAt is within visibilityTimeout isn't claimed by another worker and isn't processed", async () => {
		const registry = new JobRegistry();
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(): Promise<void> {}
		}
		registry.register(new GreetJob());
		await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "Taro" }),
			lockedAt: Date.now(),
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry, {
			visibilityTimeoutSeconds: 300,
		});
		const processed = await worker.runOnce();

		expect(processed).toBe(0);
	});

	test("a row whose lockedAt is older than visibilityTimeout is re-claimed and processed", async () => {
		const registry = new JobRegistry();
		const calls: GreetJobPayload[] = [];
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(payload: GreetJobPayload): Promise<void> {
				calls.push(payload);
			}
		}
		registry.register(new GreetJob());
		const id = await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "Taro" }),
			lockedAt: Date.now() - 301_000,
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry, {
			visibilityTimeoutSeconds: 300,
		});
		const processed = await worker.runOnce();

		expect(processed).toBe(1);
		expect(calls).toEqual([{ name: "Taro" }]);
		expect(await retrieveJob(id)).toBeUndefined();
	});

	test("when there are more rows than batchSize, only batchSize rows are processed, in ascending runAt order", async () => {
		const registry = new JobRegistry();
		const calls: string[] = [];
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(payload: GreetJobPayload): Promise<void> {
				calls.push(payload.name);
			}
		}
		registry.register(new GreetJob());
		/** Sets all three rows' scheduled run time in the past (`runAt <= now`) so they sort ascending by runAt. */
		const now = Date.now();
		await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "first" }),
			runAt: now - 2000,
		});
		await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "second" }),
			runAt: now - 1000,
		});
		await insertJob({ name: "greet", payload: JSON.stringify({ name: "third" }), runAt: now });

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry, { batchSize: 2 });
		const processed = await worker.runOnce();

		expect(processed).toBe(2);
		expect(calls).toEqual(["first", "second"]);
	});

	test("a row with a lower priority is claimed first even if its runAt is later", async () => {
		const registry = new JobRegistry();
		const calls: string[] = [];
		class GreetJob extends Job<GreetJobPayload> {
			readonly name = "greet";
			async perform(payload: GreetJobPayload): Promise<void> {
				calls.push(payload.name);
			}
		}
		registry.register(new GreetJob());
		const now = Date.now();
		await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "low priority" }),
			runAt: now - 2000,
			priority: 0,
		});
		await insertJob({
			name: "greet",
			payload: JSON.stringify({ name: "high priority" }),
			runAt: now - 1000,
			priority: -1,
		});

		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const processed = await worker.runOnce();

		expect(processed).toBe(2);
		expect(calls).toEqual(["high priority", "low priority"]);
	});

	test("run stops when the AbortSignal is aborted", async () => {
		// Only this test reverts to real timers, to verify the setTimeout-based polling wait in real time.
		vi.useRealTimers();

		const registry = new JobRegistry();
		const worker = new MySqlDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(worker.run({ signal: controller.signal, intervalMs: 5 })).resolves.toBeUndefined();
	});
});
