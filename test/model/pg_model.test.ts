/**
 * Verifies `PgModel` (a thin abstract base built on Drizzle pg-core).
 * Confirms the same aspects (auto id generation, auto timestamps, paginate,
 * updateWhere count, upsert, with(tx), increment/decrement) as
 * `sqlite_model.test.ts`, using PGlite (`@electric-sql/pglite`, an in-process
 * WASM Postgres). Rather than the app's `db/schema`, `test/helpers/`, or
 * migration files, this file defines a minimal Drizzle schema inline (`src/`
 * must never import application code).
 *
 * `new PGlite()` alone gives an in-memory database, and PGlite does not have
 * the post-transaction connection hand-off issue that `@libsql/client` has
 * (see the module JSDoc in `sqlite_model.test.ts`), so unlike the SQLite
 * version, a file-based per-test database is unnecessary (each instance just
 * creates its own independent in-memory database).
 */
import { PGlite } from "@electric-sql/pglite";
import { and, eq, isNull } from "drizzle-orm";
import type { NeonHttpQueryResultHKT } from "drizzle-orm/neon-http";
import { bigint, integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import type { PgliteDatabase, PgliteQueryResultHKT } from "drizzle-orm/pglite";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { IdGenerator } from "../../src/support/id_generator.js";
import { PgModel } from "../../src/model/pg_model.js";
import { StaleRecordError } from "../../src/model/stale_record_error.js";

/**
 * `createdAt`/`updatedAt` store an epoch ms value (`Date.now()`, which needs
 * 64-bit precision), so they do not fit in Postgres's 32-bit `integer`
 * (detected at PGlite runtime as `value ... is out of range for type
 * integer`). `bigint(..., { mode: "number" })` is used instead (treated as a
 * JS number within its 53-bit safe-integer range; epoch ms never exceeds
 * 2^53, so no precision is lost). The SQLite version
 * (`sqlite_model.test.ts`) keeps `integer` because SQLite's `INTEGER` column
 * is itself a variable-length integer (up to 8 bytes) and does not conflict
 * with JS's `number`.
 */
const items = pgTable("items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	status: text("status").notNull().default("draft"),
	count: integer("count").notNull().default(0),
	lockVersion: integer("lock_version").notNull().default(0),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
	deletedAt: bigint("deleted_at", { mode: "number" }),
});

/** A table without a `lockVersion` column (used to verify the unsupported-column error from `updateLocked`). */
const unlockedItems = pgTable("unlocked_items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});

const schema = { items, unlockedItems };

class ItemModel extends PgModel<
	typeof items,
	typeof items.id,
	PgliteQueryResultHKT,
	typeof schema
> {
	protected get table() {
		return items;
	}
	protected get primaryKey() {
		return items.id;
	}
}

class UnlockedItemModel extends PgModel<
	typeof unlockedItems,
	typeof unlockedItems.id,
	PgliteQueryResultHKT,
	typeof schema
> {
	protected get table() {
		return unlockedItems;
	}
	protected get primaryKey() {
		return unlockedItems.id;
	}
}

/** A deterministic test ID generator stub that returns `id-0001`, `id-0002`, ... in call order. */
class StubIdGenerator extends IdGenerator {
	private counter = 0;

	generate(): string {
		this.counter += 1;
		return `id-${String(this.counter).padStart(4, "0")}`;
	}
}

/** Creates an independent in-memory PGlite client, Drizzle wrapper, and cleanup function for each test. */
const createItemsTestDb = async () => {
	const client = new PGlite();
	await client.exec(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			count INTEGER NOT NULL DEFAULT 0,
			lock_version INTEGER NOT NULL DEFAULT 0,
			created_at BIGINT NOT NULL,
			updated_at BIGINT NOT NULL,
			deleted_at BIGINT
		)
	`);
	await client.exec(`
		CREATE TABLE unlocked_items (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)
	`);
	const db = drizzle(client, { schema });
	const cleanup = () => client.close();
	return { db, cleanup };
};

describe("PgModel", () => {
	let ctx: Awaited<ReturnType<typeof createItemsTestDb>>;
	let idGenerator: StubIdGenerator;
	let model: ItemModel;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));
		ctx = await createItemsTestDb();
		idGenerator = new StubIdGenerator();
		model = new ItemModel(ctx.db, idGenerator);
	});

	afterEach(async () => {
		vi.useRealTimers();
		await ctx.cleanup();
	});

	test("create assigns an id via IdGenerator when omitted, and sets createdAt/updatedAt to the current time", async () => {
		const row = await model.create({ name: "First Book" });

		expect(row.id).toBe("id-0001");
		expect(row.createdAt).toBe(Date.now());
		expect(row.updatedAt).toBe(Date.now());
		// The DB-side default (status='draft') is correctly reflected via `.returning()`.
		expect(row.status).toBe("draft");
		expect(row.count).toBe(0);
	});

	test("create uses an explicitly given id as-is without consuming IdGenerator", async () => {
		const row = await model.create({ id: "custom-id", name: "Assigned ID" });
		expect(row.id).toBe("custom-id");

		const next = await model.create({ name: "Next Item" });
		expect(next.id).toBe("id-0001");
	});

	test("createMany creates multiple rows each with a distinct id, and does nothing for an empty array", async () => {
		const rows = await model.createMany([{ name: "A" }, { name: "B" }]);
		expect(rows.map((r) => r.id)).toEqual(["id-0001", "id-0002"]);

		const empty = await model.createMany([]);
		expect(empty).toEqual([]);
		await expect(model.count()).resolves.toBe(2);
	});

	test("update always sets updatedAt to the current time and leaves createdAt unchanged", async () => {
		const created = await model.create({ name: "Original Name" });

		vi.setSystemTime(new Date("2026-07-05T00:10:00.000Z"));
		const updated = await model.update(created.id, { name: "Updated Name" });

		expect(updated?.name).toBe("Updated Name");
		expect(updated?.createdAt).toBe(created.createdAt);
		expect(updated?.updatedAt).toBe(Date.now());
		expect(updated?.updatedAt).not.toBe(created.updatedAt);
	});

	test("retrieve returns the row if it exists, otherwise undefined", async () => {
		const created = await model.create({ name: "Target" });

		await expect(model.retrieve(created.id)).resolves.toMatchObject({ name: "Target" });
		await expect(model.retrieve("no-such-id")).resolves.toBeUndefined();
	});

	test("list, retrieveBy, exists, count, and pluck return results matching the given condition", async () => {
		await model.create({ name: "Draft A", status: "draft" });
		await model.create({ name: "Published B", status: "published" });
		await model.create({ name: "Draft C", status: "draft" });

		const drafts = await model.list(eq(items.status, "draft"));
		expect(drafts.map((r) => r.name).sort()).toEqual(["Draft A", "Draft C"]);

		await expect(model.retrieveBy(eq(items.status, "published"))).resolves.toMatchObject({
			name: "Published B",
		});
		await expect(model.retrieveBy(eq(items.status, "archived"))).resolves.toBeUndefined();

		await expect(model.exists(eq(items.status, "published"))).resolves.toBe(true);
		await expect(model.exists(eq(items.status, "archived"))).resolves.toBe(false);

		await expect(model.count()).resolves.toBe(3);
		await expect(model.count(eq(items.status, "draft"))).resolves.toBe(2);

		const names = await model.pluck(items.name, eq(items.status, "draft"));
		expect(names.sort()).toEqual(["Draft A", "Draft C"]);
	});

	test("paginate advances by cursor and correctly returns hasMore/nextCursor, scanning every row without duplicates", async () => {
		for (let i = 1; i <= 5; i++) {
			await model.create({ name: `item${i}` });
		}

		const page1 = await model.paginate({ limit: 2 });
		expect(page1.rows.map((r) => r.id)).toEqual(["id-0001", "id-0002"]);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).toBe("id-0002");

		const page2 = await model.paginate({ cursor: page1.nextCursor ?? undefined, limit: 2 });
		expect(page2.rows.map((r) => r.id)).toEqual(["id-0003", "id-0004"]);
		expect(page2.hasMore).toBe(true);
		expect(page2.nextCursor).toBe("id-0004");

		const page3 = await model.paginate({ cursor: page2.nextCursor ?? undefined, limit: 2 });
		expect(page3.rows.map((r) => r.id)).toEqual(["id-0005"]);
		expect(page3.hasMore).toBe(false);
		expect(page3.nextCursor).toBeNull();
	});

	test("paginate with direction: 'desc' scans every row in descending primary-key order without duplicates", async () => {
		for (let i = 1; i <= 5; i++) {
			await model.create({ name: `item${i}` });
		}

		const page1 = await model.paginate({ limit: 2, direction: "desc" });
		expect(page1.rows.map((r) => r.id)).toEqual(["id-0005", "id-0004"]);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).toBe("id-0004");

		const page2 = await model.paginate({
			cursor: page1.nextCursor ?? undefined,
			limit: 2,
			direction: "desc",
		});
		expect(page2.rows.map((r) => r.id)).toEqual(["id-0003", "id-0002"]);
		expect(page2.hasMore).toBe(true);
		expect(page2.nextCursor).toBe("id-0002");

		const page3 = await model.paginate({
			cursor: page2.nextCursor ?? undefined,
			limit: 2,
			direction: "desc",
		});
		expect(page3.rows.map((r) => r.id)).toEqual(["id-0001"]);
		expect(page3.hasMore).toBe(false);
		expect(page3.nextCursor).toBeNull();
	});

	test("paginate advances by cursor while filtered by where, without mixing in rows outside the filter", async () => {
		for (let i = 1; i <= 5; i++) {
			await model.create({ name: `published-item${i}`, status: "published" });
		}
		for (let i = 1; i <= 3; i++) {
			await model.create({ name: `draft-item${i}`, status: "draft" });
		}

		const publishedCondition = eq(items.status, "published");

		const page1 = await model.paginate({ limit: 2, where: publishedCondition });
		expect(page1.rows.every((r) => r.status === "published")).toBe(true);
		expect(page1.rows.map((r) => r.id)).toEqual(["id-0001", "id-0002"]);
		expect(page1.hasMore).toBe(true);

		const page2 = await model.paginate({
			cursor: page1.nextCursor ?? undefined,
			limit: 2,
			where: publishedCondition,
		});
		expect(page2.rows.every((r) => r.status === "published")).toBe(true);
		expect(page2.rows.map((r) => r.id)).toEqual(["id-0003", "id-0004"]);
		expect(page2.hasMore).toBe(true);

		const page3 = await model.paginate({
			cursor: page2.nextCursor ?? undefined,
			limit: 2,
			where: publishedCondition,
		});
		expect(page3.rows.map((r) => r.id)).toEqual(["id-0005"]);
		expect(page3.hasMore).toBe(false);
		expect(page3.nextCursor).toBeNull();
	});

	test("listPage sorts by an arbitrary column, paginates via limit/offset, and defaults to primary key order", async () => {
		for (let i = 1; i <= 5; i++) {
			await model.create({ name: `item${i}`, status: "published" });
		}

		const byNameDesc = await model.listPage({
			orderBy: [{ column: items.name, direction: "desc" }],
			limit: 2,
			offset: 0,
		});
		expect(byNameDesc.map((r) => r.name)).toEqual(["item5", "item4"]);

		const page2 = await model.listPage({ limit: 2, offset: 2 });
		expect(page2.map((r) => r.id)).toEqual(["id-0003", "id-0004"]);

		const filtered = await model.listPage({
			where: eq(items.status, "draft"),
			limit: 10,
		});
		expect(filtered).toEqual([]);
	});

	test("updateWhere returns the number of matched rows, or 0 when the condition no longer matches (optimistic locking)", async () => {
		const created = await model.create({ name: "Target", status: "draft" });

		const draftCondition = and(eq(items.id, created.id), eq(items.status, "draft"));

		const first = await model.updateWhere(draftCondition, { status: "published" });
		expect(first).toBe(1);

		const second = await model.updateWhere(draftCondition, { status: "archived" });
		expect(second).toBe(0);
		await expect(model.retrieve(created.id)).resolves.toMatchObject({ status: "published" });
	});

	test("deleteWhere deletes exactly the matching rows, returns their count, and leaves the rest untouched", async () => {
		const draftA = await model.create({ name: "Draft A", status: "draft" });
		const published = await model.create({ name: "Published B", status: "published" });
		const draftC = await model.create({ name: "Draft C", status: "draft" });

		const deletedCount = await model.deleteWhere(eq(items.status, "draft"));
		expect(deletedCount).toBe(2);

		await expect(model.retrieve(draftA.id)).resolves.toBeUndefined();
		await expect(model.retrieve(draftC.id)).resolves.toBeUndefined();
		await expect(model.retrieve(published.id)).resolves.toMatchObject({ name: "Published B" });

		const noMatch = await model.deleteWhere(eq(items.status, "draft"));
		expect(noMatch).toBe(0);
	});

	test("increment/decrement add to or subtract from the given column", async () => {
		const created = await model.create({ name: "Counter", count: 0 });

		await model.increment(created.id, items.count, 5);
		await expect(model.retrieve(created.id)).resolves.toMatchObject({ count: 5 });

		await model.decrement(created.id, items.count, 2);
		await expect(model.retrieve(created.id)).resolves.toMatchObject({ count: 3 });

		await model.increment(created.id, items.count);
		await expect(model.retrieve(created.id)).resolves.toMatchObject({ count: 4 });
	});

	test("upsert updates with the set contents on a primary-key conflict, and creates a new row otherwise", async () => {
		const created = await model.upsert(
			{ id: "fixed-id", name: "First Created" },
			{ target: items.id, set: { name: "Updated" } },
		);
		expect(created.name).toBe("First Created");

		const updated = await model.upsert(
			{ id: "fixed-id", name: "Ignored Value" },
			{ target: items.id, set: { name: "Updated" } },
		);
		expect(updated.name).toBe("Updated");
		await expect(model.count()).resolves.toBe(1);
	});

	test("touch updates only updatedAt to the current time", async () => {
		const created = await model.create({ name: "Target" });

		vi.setSystemTime(new Date("2026-07-05T00:20:00.000Z"));
		await model.touch(created.id);

		const touched = await model.retrieve(created.id);
		expect(touched?.name).toBe(created.name);
		expect(touched?.updatedAt).toBe(Date.now());
	});

	test("listIn bulk-fetches rows matching multiple values, returning [] for an empty array or no matches", async () => {
		await model.create({ name: "Draft A", status: "draft" });
		await model.create({ name: "Published B", status: "published" });
		await model.create({ name: "Archived C", status: "archived" });

		const hit = await model.listIn(items.status, ["draft", "published"]);
		expect(hit.map((r) => r.name).sort()).toEqual(["Draft A", "Published B"]);

		await expect(model.listIn(items.status, [])).resolves.toEqual([]);
		await expect(model.listIn(items.status, ["no-such-status"])).resolves.toEqual([]);
	});

	test("listIn/retrieveMany throw for a value set exceeding maxInValues (default 1000), and behave as before within the limit", async () => {
		const overLimit = Array.from({ length: 1001 }, (_, i) => `status-${i}`);
		await expect(model.listIn(items.status, overLimit)).rejects.toThrow();
		await expect(model.retrieveMany(overLimit)).rejects.toThrow();

		const withinLimit = Array.from({ length: 1000 }, (_, i) => `status-${i}`);
		await expect(model.listIn(items.status, withinLimit)).resolves.toEqual([]);

		const customLimitModel = new ItemModel(ctx.db, idGenerator, 2);
		await expect(customLimitModel.listIn(items.status, ["a", "b", "c"])).rejects.toThrow();
		await expect(customLimitModel.listIn(items.status, ["a", "b"])).resolves.toEqual([]);
	});

	test("groupedIn returns a Map grouped by column value, with no key at all for values with no matches", async () => {
		await model.create({ name: "Draft A", status: "draft" });
		await model.create({ name: "Draft B", status: "draft" });
		await model.create({ name: "Published C", status: "published" });

		const grouped = await model.groupedIn(items.status, ["draft", "published", "archived"]);
		expect(
			grouped
				.get("draft")
				?.map((r) => r.name)
				.sort(),
		).toEqual(["Draft A", "Draft B"]);
		expect(grouped.get("published")?.map((r) => r.name)).toEqual(["Published C"]);
		expect(grouped.has("archived")).toBe(false);

		const empty = await model.groupedIn(items.status, []);
		expect(empty.size).toBe(0);
	});

	test("retrieveMany bulk-fetches a set of primary keys into a Map, handling a nonexistent pk, a duplicate pk, and an empty array", async () => {
		const a = await model.create({ name: "Target A" });
		const b = await model.create({ name: "Target B" });

		const found = await model.retrieveMany([a.id, b.id, "no-such-id", a.id]);
		expect(found.size).toBe(2);
		expect(found.get(a.id)?.name).toBe("Target A");
		expect(found.get(b.id)?.name).toBe("Target B");
		expect(found.has("no-such-id")).toBe(false);

		const empty = await model.retrieveMany([]);
		expect(empty.size).toBe(0);
	});

	test("updateLocked updates when expectedVersion matches, incrementing and returning lockVersion", async () => {
		const created = await model.create({ name: "Target" });
		expect(created.lockVersion).toBe(0);

		const updated = await model.updateLocked(created.id, created.lockVersion, {
			name: "Updated",
		});
		expect(updated.name).toBe("Updated");
		expect(updated.lockVersion).toBe(1);
	});

	test("updateLocked throws StaleRecordError when expectedVersion is already stale", async () => {
		const created = await model.create({ name: "Target" });
		await model.updateLocked(created.id, created.lockVersion, { name: "First Update" });

		await expect(
			model.updateLocked(created.id, created.lockVersion, { name: "Conflicting Update" }),
		).rejects.toThrow(StaleRecordError);

		await expect(model.retrieve(created.id)).resolves.toMatchObject({
			name: "First Update",
			lockVersion: 1,
		});
	});

	test("updateLocked throws StaleRecordError for a nonexistent pk", async () => {
		await expect(model.updateLocked("no-such-id", 0, { name: "Ignored" })).rejects.toThrow(
			StaleRecordError,
		);
	});

	test("updateLocked overwrites with its own managed value even if lockVersion is mixed into the patch", async () => {
		const created = await model.create({ name: "Target" });

		const updated = await model.updateLocked(created.id, created.lockVersion, {
			name: "Updated",
			lockVersion: 999,
		});
		expect(updated.lockVersion).toBe(1);
	});

	test("updateLocked throws a clear message for a table with no lockVersion column", async () => {
		const unlockedModel = new UnlockedItemModel(ctx.db, idGenerator);
		const created = await unlockedModel.create({ name: "Target" });

		await expect(unlockedModel.updateLocked(created.id, 0, { name: "Updated" })).rejects.toThrow(
			/lockVersion/,
		);
	});

	test("softDelete updates deletedAt to the current time, and restore reverts it to null", async () => {
		const created = await model.create({ name: "Target" });
		expect(created.deletedAt).toBeNull();

		vi.setSystemTime(new Date("2026-07-05T00:30:00.000Z"));
		const deleted = await model.softDelete(created.id);
		expect(deleted?.deletedAt).toBe(Date.now());
		expect(deleted?.updatedAt).toBe(Date.now());

		const restored = await model.restore(created.id);
		expect(restored?.deletedAt).toBeNull();
	});

	test("softDelete simply overwrites deletedAt with a new time even on an already-deleted row", async () => {
		const created = await model.create({ name: "Target" });
		const first = await model.softDelete(created.id);

		vi.setSystemTime(new Date("2026-07-05T00:40:00.000Z"));
		const second = await model.softDelete(created.id);
		expect(second?.deletedAt).toBe(Date.now());
		expect(second?.deletedAt).not.toBe(first?.deletedAt);
	});

	test("softDelete/restore return undefined for a nonexistent pk", async () => {
		await expect(model.softDelete("no-such-id")).resolves.toBeUndefined();
		await expect(model.restore("no-such-id")).resolves.toBeUndefined();
	});

	test("softDelete/restore throw a clear message for a table with no deletedAt column", async () => {
		const unlockedModel = new UnlockedItemModel(ctx.db, idGenerator);
		const created = await unlockedModel.create({ name: "Target" });

		await expect(unlockedModel.softDelete(created.id)).rejects.toThrow(/deletedAt/);
		await expect(unlockedModel.restore(created.id)).rejects.toThrow(/deletedAt/);
	});

	test("explicitly passing isNull(table.deletedAt) to list excludes deleted rows (no automatic exclusion)", async () => {
		const a = await model.create({ name: "Remains" });
		const b = await model.create({ name: "Removed" });
		await model.softDelete(b.id);

		const all = await model.list();
		expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

		const active = await model.list(isNull(items.deletedAt));
		expect(active.map((r) => r.id)).toEqual([a.id]);
	});

	test("with(tx) works within a transaction: committing applies changes, rolling back reverts them", async () => {
		await expect(
			ctx.db.transaction(async (tx) => {
				const txModel = model.with(tx);
				await txModel.create({ id: "rollback-me", name: "Rolled Back" });
				throw new Error("intentional failure to trigger rollback");
			}),
		).rejects.toThrow("intentional failure to trigger rollback");

		await expect(model.retrieve("rollback-me")).resolves.toBeUndefined();

		await ctx.db.transaction(async (tx) => {
			const txModel = model.with(tx);
			await txModel.create({ id: "commit-me", name: "Committed" });
		});

		await expect(model.retrieve("commit-me")).resolves.toMatchObject({ name: "Committed" });
	});

	test("retrieveForUpdate fetches the row with a row lock inside a transaction, returning undefined for a nonexistent pk", async () => {
		const created = await model.create({ name: "Target" });

		await ctx.db.transaction(async (tx) => {
			const txModel = model.with(tx);
			await expect(txModel.retrieveForUpdate(created.id)).resolves.toMatchObject({
				name: "Target",
			});
			await expect(txModel.retrieveForUpdate("no-such-id")).resolves.toBeUndefined();
		});
	});
});

/**
 * Type-level test: guarantees compatibility with the major Postgres drivers.
 * `PgModel` is designed to promote `TQueryResult extends PgQueryResultHKT` to
 * a class type parameter (see the module JSDoc in `pg_model.ts`), so this
 * checks - purely at the type level - that `PostgresJsDatabase`
 * (`PostgresJsQueryResultHKT`), `NeonHttpDatabase` (`NeonHttpQueryResultHKT`),
 * and `PgliteDatabase` (`PgliteQueryResultHKT`, already verified at runtime
 * via `ItemModel` above) can each be passed to the constructor of a `PgModel`
 * subclass with the matching `TQueryResult` (the same shape as the D1 case;
 * no runtime value is ever created - the check is simply that `tsc --noEmit`,
 * i.e. `vp run typecheck`, compiles).
 */
class PostgresJsItemModel extends PgModel<
	typeof items,
	typeof items.id,
	PostgresJsQueryResultHKT,
	typeof schema
> {
	protected get table() {
		return items;
	}
	protected get primaryKey() {
		return items.id;
	}
}
type _PostgresJsDbParam = ConstructorParameters<typeof PostgresJsItemModel>[0];
type _AssertPostgresJsAssignable = import("drizzle-orm/postgres-js").PostgresJsDatabase<
	typeof schema
> extends _PostgresJsDbParam
	? true
	: false;
true satisfies _AssertPostgresJsAssignable;

class NeonHttpItemModel extends PgModel<
	typeof items,
	typeof items.id,
	NeonHttpQueryResultHKT,
	typeof schema
> {
	protected get table() {
		return items;
	}
	protected get primaryKey() {
		return items.id;
	}
}
type _NeonHttpDbParam = ConstructorParameters<typeof NeonHttpItemModel>[0];
type _AssertNeonHttpAssignable = import("drizzle-orm/neon-http").NeonHttpDatabase<
	typeof schema
> extends _NeonHttpDbParam
	? true
	: false;
true satisfies _AssertNeonHttpAssignable;

type _PgliteDbParam = ConstructorParameters<typeof ItemModel>[0];
type _AssertPgliteAssignable = PgliteDatabase<typeof schema> extends _PgliteDbParam ? true : false;
true satisfies _AssertPgliteAssignable;
