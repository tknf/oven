/**
 * Verifies `SQLiteModel` (a thin abstract base built on Drizzle sqlite-core).
 * Rather than the app's `db/schema`, `test/helpers/`, or migration files,
 * this file defines a minimal Drizzle schema inline (`src/` must never
 * import application code).
 *
 * The database uses a per-test temp file rather than `:memory:`. Reason:
 * `@libsql/client`'s Node-native (sqlite3) driver hands off the original
 * connection when `db.transaction()` starts, and lazily creates a new
 * connection for subsequent (non-transactional) operations. Since
 * `:memory:` is a separate database per connection, running a
 * non-transactional query on the same `db` handle right after calling
 * `db.transaction()` - as the with(tx) rollback/commit checks do - would hit
 * `no such table` and the check would not hold (`src/test/db.ts` uses a
 * file for the same reason, and this has been confirmed to reproduce on
 * real runs). With a file, a new connection still points at the same file,
 * so this problem does not occur.
 */
import { createClient } from "@libsql/client";
import { and, eq, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { IdGenerator } from "../../src/support/id_generator.js";
import { SQLiteModel } from "../../src/model/sqlite_model.js";
import { StaleRecordError } from "../../src/model/stale_record_error.js";

const items = sqliteTable("items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	status: text("status").notNull().default("draft"),
	count: integer("count").notNull().default(0),
	lockVersion: integer("lock_version").notNull().default(0),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
	deletedAt: integer("deleted_at"),
});

/** A table without a `lockVersion` column (used to verify the unsupported-column error from `updateLocked`). */
const unlockedItems = sqliteTable("unlocked_items", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
});

const schema = { items, unlockedItems };

class ItemModel extends SQLiteModel<typeof items, typeof items.id, typeof schema> {
	protected get table() {
		return items;
	}
	protected get primaryKey() {
		return items.id;
	}
}

class UnlockedItemModel extends SQLiteModel<
	typeof unlockedItems,
	typeof unlockedItems.id,
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

/**
 * Creates a per-test temp-file libSQL client, Drizzle wrapper, and cleanup
 * function (uses a file for the same reason as `createTestDb` in
 * `src/test/db.ts`, but differs in that it runs `CREATE TABLE` directly for
 * this test-only schema instead of using migrations).
 */
const createItemsTestDb = async () => {
	const dir = mkdtempSync(join(tmpdir(), "oven-model-test-"));
	const client = createClient({ url: `file:${join(dir, `${randomUUID()}.sqlite`)}` });
	await client.execute("PRAGMA foreign_keys = ON");
	await client.execute(`
		CREATE TABLE items (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'draft',
			count INTEGER NOT NULL DEFAULT 0,
			lock_version INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			deleted_at INTEGER
		)
	`);
	await client.execute(`
		CREATE TABLE unlocked_items (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL
		)
	`);
	const db = drizzle(client, { schema });
	const cleanup = () => {
		client.close();
		rmSync(dir, { recursive: true, force: true });
	};
	return { db, cleanup };
};

describe("SQLiteModel", () => {
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

	afterEach(() => {
		vi.useRealTimers();
		ctx.cleanup();
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
		const row = await model.create({ id: "custom-id", name: "Specified ID" });
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

	test("delete returns the deleted row, and re-running on a nonexistent or already-deleted pk returns undefined", async () => {
		const created = await model.create({ name: "Delete Target" });

		await expect(model.delete("no-such-id")).resolves.toBeUndefined();

		const deleted = await model.delete(created.id);
		expect(deleted).toMatchObject({ name: "Delete Target" });
		await expect(model.delete(created.id)).resolves.toBeUndefined();
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
			await model.create({ name: `PublishedItem${i}`, status: "published" });
		}
		for (let i = 1; i <= 3; i++) {
			await model.create({ name: `DraftItem${i}`, status: "draft" });
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

	test("listPage sorts by an arbitrary column and direction, including multi-column order", async () => {
		await model.create({ name: "Charlie", count: 1 });
		await model.create({ name: "Alpha", count: 2 });
		await model.create({ name: "Bravo", count: 2 });

		const byNameAsc = await model.listPage({
			orderBy: [{ column: items.name, direction: "asc" }],
			limit: 10,
		});
		expect(byNameAsc.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"]);

		const byNameDesc = await model.listPage({
			orderBy: [{ column: items.name, direction: "desc" }],
			limit: 10,
		});
		expect(byNameDesc.map((r) => r.name)).toEqual(["Charlie", "Bravo", "Alpha"]);

		const byCountThenName = await model.listPage({
			orderBy: [
				{ column: items.count, direction: "desc" },
				{ column: items.name, direction: "asc" },
			],
			limit: 10,
		});
		expect(byCountThenName.map((r) => r.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
	});

	test("listPage paginates via limit/offset without duplicating or skipping rows", async () => {
		for (let i = 1; i <= 5; i++) {
			await model.create({ name: `item${i}` });
		}

		const page1 = await model.listPage({ limit: 2, offset: 0 });
		expect(page1.map((r) => r.id)).toEqual(["id-0001", "id-0002"]);

		const page2 = await model.listPage({ limit: 2, offset: 2 });
		expect(page2.map((r) => r.id)).toEqual(["id-0003", "id-0004"]);

		const page3 = await model.listPage({ limit: 2, offset: 4 });
		expect(page3.map((r) => r.id)).toEqual(["id-0005"]);
	});

	test("listPage defaults to primary key ascending order when orderBy is omitted", async () => {
		for (let i = 1; i <= 3; i++) {
			await model.create({ name: `item${i}` });
		}

		const page = await model.listPage({ limit: 10 });
		expect(page.map((r) => r.id)).toEqual(["id-0001", "id-0002", "id-0003"]);
	});

	test("listPage combines a where filter with ordering and offset", async () => {
		for (let i = 1; i <= 3; i++) {
			await model.create({ name: `PublishedItem${i}`, status: "published" });
		}
		for (let i = 1; i <= 2; i++) {
			await model.create({ name: `DraftItem${i}`, status: "draft" });
		}

		const page = await model.listPage({
			where: eq(items.status, "published"),
			orderBy: [{ column: items.name, direction: "desc" }],
			limit: 2,
			offset: 1,
		});
		expect(page.map((r) => r.name)).toEqual(["PublishedItem2", "PublishedItem1"]);
		expect(page.every((r) => r.status === "published")).toBe(true);
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
			{ id: "fixed-id", name: "Initial Create" },
			{ target: items.id, set: { name: "Updated" } },
		);
		expect(created.name).toBe("Initial Create");

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
		await model.create({ name: "Archive C", status: "archived" });

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
				await txModel.create({ id: "rollback-me", name: "RolledBack" });
				throw new Error("Deliberately fail to trigger rollback");
			}),
		).rejects.toThrow("Deliberately fail to trigger rollback");

		await expect(model.retrieve("rollback-me")).resolves.toBeUndefined();

		await ctx.db.transaction(async (tx) => {
			const txModel = model.with(tx);
			await txModel.create({ id: "commit-me", name: "Committed" });
		});

		await expect(model.retrieve("commit-me")).resolves.toMatchObject({ name: "Committed" });
	});
});

/**
 * Type-level test: guarantees D1 compatibility (prevents regressing the
 * "Cloudflare Workers first" principle). In the old implementation, where
 * `SQLiteModel`'s `db` parameter was fixed to `@libsql/client`'s
 * `ResultSet`, passing a `DrizzleD1Database` (`TRunResult = D1Result`) was a
 * type error. This checks - purely at the type level, creating no runtime
 * value - whether `DrizzleD1Database` is assignable to the type of
 * `ItemModel`'s first constructor parameter (using `satisfies` so that "not
 * assignable" becomes a compile error; there is no runtime assertion - the
 * check is simply that `tsc --noEmit`, i.e. `vp run typecheck`, compiles).
 */
type _D1DbParam = ConstructorParameters<typeof ItemModel>[0];
type _AssertD1AssignableToModelDb =
	DrizzleD1Database<typeof schema> extends _D1DbParam ? true : false;
true satisfies _AssertD1AssignableToModelDb;
