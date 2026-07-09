/**
 * Tests `MySqlAuditLog` (the MySQL version of the class that provides an audit log
 * backed only by the RDB; `src/audit/mysql_audit_log.ts`). Verifies the same aspects as
 * `test/audit/sqlite_audit_log.test.ts` against a real MySQL server (Docker), the
 * `audits` table in `test/test_support/fixtures/mysql_schema.ts`, and
 * `mysql_migrations` (applying migrations using the same approach as
 * `test/jobs/mysql_database_job_queue.test.ts`).
 *
 * If the `OVEN_MYSQL_TEST_URL` environment variable is not set, every test in this file
 * is skipped via `describe.skipIf` (the same gate as
 * `test/jobs/mysql_database_job_queue.test.ts`).
 *
 * ## Running locally
 * ```sh
 * docker run --rm -d --name oven-mysql-test \
 *   -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=oven_test \
 *   -p 3306:3306 mysql:8
 * OVEN_MYSQL_TEST_URL="mysql://root:root@127.0.0.1:3306/oven_test" vp test --project node -- test/audit/mysql_audit_log.test.ts
 * docker stop oven-mysql-test
 * ```
 */
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { createConnection } from "mysql2/promise";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { MySqlAuditLog } from "../../src/audit/mysql_audit_log.js";
import { IdGenerator } from "../../src/support/id_generator.js";
import * as schema from "../test_support/fixtures/mysql_schema.js";

const OVEN_MYSQL_TEST_URL = process.env.OVEN_MYSQL_TEST_URL;
const migrationsFolder = new URL("../test_support/fixtures/mysql_migrations", import.meta.url)
	.pathname;

/** Deterministic ID-generator stub for tests (same approach as `test/jobs/mysql_database_job_queue.test.ts`). */
class StubIdGenerator extends IdGenerator {
	private counter = 0;

	generate(): string {
		this.counter += 1;
		return `audit-${String(this.counter).padStart(4, "0")}`;
	}
}

/**
 * Connects, applies migrations, and clears any `audits` rows left over from the
 * previous test before returning. Other tables such as `publishers` are untouched
 * since this file does not use them.
 */
const createTestDb = async (url: string) => {
	const connection = await createConnection(url);
	const db = drizzle(connection, { schema, mode: "default" });
	await migrate(db, { migrationsFolder });
	await connection.query("DELETE FROM audits");
	return { connection, db };
};

describe.skipIf(!OVEN_MYSQL_TEST_URL)("MySqlAuditLog", () => {
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

	test("record inserts one row with id/createdAt set automatically", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });

		const rows = await ctx.db.select().from(schema.audits);
		expect(rows).toEqual([
			{
				id: "audit-0001",
				actor: "user-1",
				action: "user.update",
				target: "user-2",
				changes: null,
				createdAt: Date.now(),
			},
		]);
	});

	test("passing an object as changes stores it as a JSON string", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({
			actor: "user-1",
			action: "user.update",
			target: "user-2",
			changes: { name: { from: "Taro", to: "Hanako" } },
		});

		const [row] = await ctx.db.select().from(schema.audits);
		expect(row?.changes).toBe(JSON.stringify({ name: { from: "Taro", to: "Hanako" } }));
	});

	test("null is stored when changes is not specified", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-2" });

		const [row] = await ctx.db.select().from(schema.audits);
		expect(row?.changes).toBeNull();
	});

	test("when idGenerator is omitted, the id is a numeric string issued by SnowflakeIdGenerator", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits);

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });

		const [row] = await ctx.db.select().from(schema.audits);
		expect(row?.id).toMatch(/^\d+$/);
	});

	test("list returns multiple recorded results ordered by createdAt descending (most recent first)", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		vi.setSystemTime(new Date("2026-07-06T00:00:01.000Z"));
		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-3" });

		const rows = await auditLog.list();
		expect(rows.map((row) => row.id)).toEqual(["audit-0002", "audit-0001"]);
	});

	test("list narrows down with an AND condition for whichever of actor/action/target are specified", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-2" });
		await auditLog.record({ actor: "user-9", action: "user.update", target: "user-2" });

		const rows = await auditLog.list({ actor: "user-1", action: "user.update" });
		expect(rows.map((row) => row.id)).toEqual(["audit-0001"]);
	});

	test("list limits the number of results returned via limit", async () => {
		const auditLog = new MySqlAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });

		const rows = await auditLog.list({ limit: 2 });
		expect(rows).toHaveLength(2);
	});
});
