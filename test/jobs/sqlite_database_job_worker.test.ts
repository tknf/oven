/**
 * Verifies `SQLiteDatabaseJobWorker` (the consumer side that backs the queue with
 * the relational database alone; `src/jobs/sqlite_database_job_worker.ts`).
 * Inserts rows directly into `createTestDb` (`src/test/db.ts`) using the minimal
 * fixture schema dedicated to this repository (the `jobs` table in
 * `test/test_support/fixtures/schema.ts`), and checks the behavior of `runOnce`/`run`.
 */
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createTestDb } from "../../src/test/db.js";
import { Job } from "../../src/jobs/job.js";
import { JobRegistry } from "../../src/jobs/job_registry.js";
import { SQLiteDatabaseJobWorker } from "../../src/jobs/sqlite_database_job_worker.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

type GreetJobPayload = { name: string };

/** Override values passed to insertJob. Columns other than the NOT NULL ones (name/payload) have defaults. */
type JobOverrides = Partial<typeof schema.jobs.$inferInsert> &
	Pick<typeof schema.jobs.$inferInsert, "name" | "payload">;

describe("SQLiteDatabaseJobWorker", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

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
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		vi.useRealTimers();
		ctx.client.close();
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry);
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry);
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

		const worker = new SQLiteDatabaseJobWorker(
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry, { maxAttempts: 3 });
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry, {}, { onUnknownJob });
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry, {
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry, {
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry, { batchSize: 2 });
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

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const processed = await worker.runOnce();

		expect(processed).toBe(2);
		expect(calls).toEqual(["high priority", "low priority"]);
	});

	test("from the 2nd item onward in a batch, lockedAt is claimed at the time elapsed during perform, not pinned to the batch start time", async () => {
		const registry = new JobRegistry();
		class SlowFirstJob extends Job<GreetJobPayload> {
			readonly name = "slow_first";
			async perform(): Promise<void> {
				/** Simulates the first item's perform taking time by advancing the system clock. */
				vi.setSystemTime(new Date(Date.now() + 1000));
				throw new Error("intentionally fails to leave the row for the 1st item");
			}
		}
		let secondLockedAt: number | null = null;
		class ObserveSecondJob extends Job<GreetJobPayload> {
			readonly name = "observe_second";
			async perform(): Promise<void> {
				const row = await retrieveJob(secondId);
				secondLockedAt = row?.lockedAt ?? null;
				throw new Error("intentionally fails to leave the row for the 2nd item too");
			}
		}
		registry.register(new SlowFirstJob());
		registry.register(new ObserveSecondJob());

		const batchStart = Date.now();
		await insertJob({
			name: "slow_first",
			payload: JSON.stringify({ name: "first" }),
			priority: 0,
		});
		const secondId = await insertJob({
			name: "observe_second",
			payload: JSON.stringify({ name: "second" }),
			priority: 1,
		});

		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const processed = await worker.runOnce();

		expect(processed).toBe(2);
		expect(secondLockedAt).not.toBeNull();
		/**
		 * Before the fix, the second item's lockedAt was written as the batch start
		 * time (batchStart), effectively shortening the visibility timeout. After the
		 * fix, the actual claim time (after the clock was advanced during the first
		 * item's perform) is written, so it comes out newer than batchStart.
		 */
		expect(secondLockedAt).toBeGreaterThan(batchStart);
	});

	test("run stops when the AbortSignal is aborted", async () => {
		// Only this test reverts to real timers, to verify the setTimeout-based polling wait in real time.
		vi.useRealTimers();

		const registry = new JobRegistry();
		const worker = new SQLiteDatabaseJobWorker(ctx.db, schema.jobs, registry);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(worker.run({ signal: controller.signal, intervalMs: 5 })).resolves.toBeUndefined();
	});
});
