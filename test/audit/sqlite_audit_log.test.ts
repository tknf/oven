/**
 * Tests `SQLiteAuditLog` (a class that provides an audit log backed only by the RDB;
 * `src/audit/sqlite_audit_log.ts`). Verifies the result of `record` using `createTestDb`
 * (`src/test/db.ts`) and this repo's dedicated minimal fixture schema (the `audits` table
 * in `test/test_support/fixtures/schema.ts`), following the same approach as
 * `test/jobs/sqlite_database_job_queue.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { SQLiteAuditLog } from "../../src/audit/sqlite_audit_log.js";
import { IdGenerator } from "../../src/support/id_generator.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

/** Deterministic ID-generator stub for tests (same approach as `test/jobs/sqlite_database_job_queue.test.ts`). */
class StubIdGenerator extends IdGenerator {
	private counter = 0;

	generate(): string {
		this.counter += 1;
		return `audit-${String(this.counter).padStart(4, "0")}`;
	}
}

describe("SQLiteAuditLog", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		vi.useRealTimers();
		ctx.client.close();
	});

	test("record inserts one row with id/createdAt set automatically", async () => {
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
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
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
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
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-2" });

		const [row] = await ctx.db.select().from(schema.audits);
		expect(row?.changes).toBeNull();
	});

	test("when idGenerator is omitted, the id is a numeric string issued by SnowflakeIdGenerator", async () => {
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits);

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });

		const [row] = await ctx.db.select().from(schema.audits);
		expect(row?.id).toMatch(/^\d+$/);
	});

	test("list returns multiple recorded results ordered by createdAt descending (most recent first)", async () => {
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		vi.setSystemTime(new Date("2026-07-06T00:00:01.000Z"));
		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-3" });

		const rows = await auditLog.list();
		expect(rows.map((row) => row.id)).toEqual(["audit-0002", "audit-0001"]);
	});

	test("list narrows down with an AND condition for whichever of actor/action/target are specified", async () => {
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.delete", target: "user-2" });
		await auditLog.record({ actor: "user-9", action: "user.update", target: "user-2" });

		const rows = await auditLog.list({ actor: "user-1", action: "user.update" });
		expect(rows.map((row) => row.id)).toEqual(["audit-0001"]);
	});

	test("list limits the number of results returned via limit", async () => {
		const auditLog = new SQLiteAuditLog(ctx.db, schema.audits, {
			idGenerator: new StubIdGenerator(),
		});

		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });
		await auditLog.record({ actor: "user-1", action: "user.update", target: "user-2" });

		const rows = await auditLog.list({ limit: 2 });
		expect(rows).toHaveLength(2);
	});
});
