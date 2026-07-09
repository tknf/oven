/**
 * Verifies `MySqlDatabaseJobQueue` (the MySQL variant of the producer side that
 * backs the queue with the relational database alone; `src/jobs/
 * mysql_database_job_queue.ts`). The same aspects as
 * `test/jobs/sqlite_database_job_queue.test.ts` are checked against an actual
 * MySQL server (Docker) plus the `jobs` table from
 * `test/test_support/fixtures/mysql_schema.ts` and `mysql_migrations` (migration
 * application, the MySQL counterpart of the technique used in
 * `test/test_support/pg_db.test.ts`).
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
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/jobs/mysql_database_job_queue.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { IdGenerator } from "../../src/support/id_generator.js";
import { Job } from "../../src/jobs/job.js";
import { MySqlDatabaseJobQueue } from "../../src/jobs/mysql_database_job_queue.js";
import * as schema from "../test_support/fixtures/mysql_schema.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;
const migrationsFolder = new URL("../test_support/fixtures/mysql_migrations", import.meta.url)
	.pathname;

type GreetJobPayload = { name: string };

/** A minimal job for tests. `MySqlDatabaseJobQueue` never calls `perform`, so it can be empty. */
class GreetJob extends Job<GreetJobPayload> {
	readonly name = "greet";
	async perform(): Promise<void> {}
}

/** A deterministic id-generation stub for tests (same technique as `test/model/mysql_model.test.ts`). */
class StubIdGenerator extends IdGenerator {
	private counter = 0;

	generate(): string {
		this.counter += 1;
		return `job-${String(this.counter).padStart(4, "0")}`;
	}
}

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

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlDatabaseJobQueue", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb>>;

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

	test("enqueue inserts a single row, filling id/priority/attempts/lockedAt/failedAt with initial values", async () => {
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs, {
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
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Taro" }, { priority: -1 });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.priority).toBe(-1);
	});

	test("specifying delaySeconds pushes runAt into the future by that many seconds", async () => {
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Taro" }, { delaySeconds: 60 });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.runAt).toBe(Date.now() + 60_000);
	});

	test("payload is inserted as a JSON.stringify'd string", async () => {
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await queue.enqueue(new GreetJob(), { name: "Hanako" });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.payload).toBe('{"name":"Hanako"}');
	});

	test("specifying an invalid delaySeconds throws without inserting", async () => {
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs, {
			idGenerator: new StubIdGenerator(),
		});

		await expect(
			queue.enqueue(new GreetJob(), { name: "Taro" }, { delaySeconds: -1 }),
		).rejects.toThrow(/delaySeconds/);

		const rows = await ctx.db.select().from(schema.jobs);
		expect(rows).toEqual([]);
	});

	test("when idGenerator is omitted, id is a numeric string assigned by SnowflakeIdGenerator", async () => {
		const queue = new MySqlDatabaseJobQueue(ctx.db, schema.jobs);

		await queue.enqueue(new GreetJob(), { name: "Taro" });

		const [row] = await ctx.db.select().from(schema.jobs);
		expect(row?.id).toMatch(/^\d+$/);
	});
});
