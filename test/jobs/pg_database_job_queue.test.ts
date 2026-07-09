/**
 * Verifies `PgDatabaseJobQueue` (the Postgres variant of the producer side that
 * backs the queue with the relational database alone; `src/jobs/
 * pg_database_job_queue.ts`). The same aspects as
 * `test/jobs/sqlite_database_job_queue.test.ts` are checked against PGlite
 * (an in-process WASM Postgres) plus the `jobs` table from
 * `test/test_support/fixtures/pg_schema.ts` and `pg_migrations` (the same
 * migration-application technique as `test/test_support/pg_db.test.ts`).
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { IdGenerator } from "../../src/support/id_generator.js";
import { Job } from "../../src/jobs/job.js";
import { PgDatabaseJobQueue } from "../../src/jobs/pg_database_job_queue.js";
import * as schema from "../test_support/fixtures/pg_schema.js";

const migrationsFolder = new URL("../test_support/fixtures/pg_migrations", import.meta.url)
	.pathname;

type GreetJobPayload = { name: string };

/** A minimal job for tests. `PgDatabaseJobQueue` never calls `perform`, so it can be empty. */
class GreetJob extends Job<GreetJobPayload> {
	readonly name = "greet";
	async perform(): Promise<void> {}
}

/** A deterministic id-generation stub for tests (same technique as `test/model/pg_model.test.ts`). */
class StubIdGenerator extends IdGenerator {
	private counter = 0;

	generate(): string {
		this.counter += 1;
		return `job-${String(this.counter).padStart(4, "0")}`;
	}
}

/** Creates an independent in-memory PGlite client per test, applies migrations, then returns it. */
const createTestDb = async () => {
	const client = new PGlite();
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder });
	return { client, db };
};

describe("PgDatabaseJobQueue", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		ctx = await createTestDb();
	});

	afterEach(async () => {
		vi.useRealTimers();
		await ctx.client.close();
	});

	test("enqueue inserts a single row, filling id/priority/attempts/lockedAt/failedAt with initial values", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Taro" });

		const rows = await ctx.db.select().from(schema.jobs);
		expect(rows).toEqual([
			{
				id: "job-0001",
				name: "greet",
				payload: JSON.stringify({ name: "Taro" }),
				runAt: Date.now(),
				priority: 0,
				attempts: 0,
				lockedAt: null,
				failedAt: null,
				lastError: null,
				createdAt: Date.now(),
			},
		]);
	});

	test("specifying priority inserts that value", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Taro" }, { priority: -1 });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.priority).toBe(-1);
	});

	test("specifying delaySeconds pushes runAt into the future by that many seconds", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Taro" }, { delaySeconds: 60 });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.runAt).toBe(Date.now() + 60_000);
	});

	test("payload is inserted as a JSON.stringify'd string", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Hanako" });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.payload).toBe('{"name":"Hanako"}');
	});

	test("specifying an invalid delaySeconds throws without inserting", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await expect(
			queue.enqueue(new GreetJob(), { name: "Taro" }, { delaySeconds: -1 }),
		).rejects.toThrow(/delaySeconds/);

		const rows = await ctx.db.select().from(schema.jobs);
		expect(rows).toEqual([]);
	});

	test("when idGenerator is omitted, id is a numeric string assigned by SnowflakeIdGenerator", async () => {
		const queue = new PgDatabaseJobQueue(ctx.db, schema.jobs);

		await queue.enqueue(new GreetJob(), { name: "Taro" });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.id).toMatch(/^\d+$/);
	});
});
