/**
 * Tests `SQLiteAdminGroups` (admin-panel operator groups backed by Drizzle
 * sqlite-core tables; `src/admin/sqlite_admin_groups.ts`). Uses `createTestDb`
 * (`src/test/db.ts`) with this repo's minimal fixture schema (the `adminGroups`
 * and `adminUserGroups` tables in `test/test_support/fixtures/schema.ts`),
 * following the same approach as `test/admin/sqlite_admin_accounts.test.ts`.
 * The membership table has no foreign keys, so user ids are plain strings here
 * and no `admin_users` rows are needed.
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { SQLiteAdminGroups } from "../../src/admin/sqlite_admin_groups.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

describe("SQLiteAdminGroups", () => {
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

	const groups = () =>
		new SQLiteAdminGroups(ctx.db, {
			groups: schema.adminGroups,
			userGroups: schema.adminUserGroups,
		});

	test("createGroup applies defaults and trims the name", async () => {
		const service = groups();

		const row = await service.createGroup({ name: "  Editors " });

		expect(row.name).toBe("Editors");
		expect(row.permissions).toBe("[]");
		expect(row.createdAt).toBe(Date.now());
		expect(row.updatedAt).toBe(Date.now());
		expect(row.id).not.toBe("");
	});

	test("createGroup rejects an empty name", async () => {
		await expect(groups().createGroup({ name: "   " })).rejects.toThrow(
			"group name must not be empty",
		);
	});

	test("createGroup rejects a duplicate name", async () => {
		const service = groups();
		await service.createGroup({ name: "Editors" });

		await expect(service.createGroup({ name: " Editors " })).rejects.toThrow(
			'group name "Editors" is already taken',
		);
	});

	test("createGroup keeps names case-sensitive so differently-cased names coexist", async () => {
		/**
		 * Group names are only trimmed, never lowercased (unlike usernames) — this
		 * locks the design asymmetry: "Editors" and "editors" are distinct groups.
		 */
		const service = groups();
		await service.createGroup({ name: "Editors" });

		const lower = await service.createGroup({ name: "editors" });

		expect(lower.name).toBe("editors");
		const names = (await service.listGroups()).map((row) => row.name);
		expect([...names].sort()).toEqual(["Editors", "editors"]);
	});

	test("createGroup stores the given permissions as JSON", async () => {
		const service = groups();

		const row = await service.createGroup({
			name: "Editors",
			permissions: ["resource.books.view", "audit.view"],
		});

		expect(row.permissions).toBe(JSON.stringify(["resource.books.view", "audit.view"]));
		expect(await service.groupPermissions(row.id)).toEqual(["resource.books.view", "audit.view"]);
	});

	test("updateGroup renames the group, trims the new name, and bumps updatedAt", async () => {
		const service = groups();
		const created = await service.createGroup({ name: "Editors" });
		vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));

		const updated = await service.updateGroup(created.id, { name: "  Publishers " });

		expect(updated?.name).toBe("Publishers");
		expect(updated?.updatedAt).toBe(Date.now());
		expect(updated?.updatedAt).not.toBe(created.updatedAt);
		expect(await service.findByName("Publishers")).toBeDefined();
		expect(await service.findByName("Editors")).toBeUndefined();
	});

	test("updateGroup rejects renaming to an existing name but allows a self-rename", async () => {
		const service = groups();
		const editors = await service.createGroup({ name: "Editors" });
		const ops = await service.createGroup({ name: "Ops" });

		await expect(service.updateGroup(ops.id, { name: "Editors" })).rejects.toThrow(
			'group name "Editors" is already taken',
		);
		const selfRenamed = await service.updateGroup(editors.id, { name: " Editors " });
		expect(selfRenamed?.name).toBe("Editors");
	});

	test("updateGroup rejects an empty name", async () => {
		const service = groups();
		const created = await service.createGroup({ name: "Editors" });

		await expect(service.updateGroup(created.id, { name: "   " })).rejects.toThrow(
			"group name must not be empty",
		);
	});

	test("updateGroup returns undefined for an unknown id", async () => {
		expect(await groups().updateGroup("missing", { name: "Editors" })).toBeUndefined();
	});

	test("deleteGroup removes the group and its membership rows", async () => {
		const service = groups();
		const editors = await service.createGroup({ name: "Editors" });
		const ops = await service.createGroup({ name: "Ops" });
		await service.setUserGroups("user-1", [editors.id, ops.id]);

		await service.deleteGroup(editors.id);

		expect(await service.retrieve(editors.id)).toBeUndefined();
		expect(await service.groupMembers(editors.id)).toEqual([]);
		expect((await service.userGroups("user-1")).map((row) => row.name)).toEqual(["Ops"]);
	});

	test("retrieve returns undefined for an unknown id", async () => {
		expect(await groups().retrieve("missing")).toBeUndefined();
	});

	test("findByName trims the lookup name and matches case-sensitively", async () => {
		const service = groups();
		await service.createGroup({ name: "Editors" });

		expect(await service.findByName("  Editors ")).toBeDefined();
		expect(await service.findByName("editors")).toBeUndefined();
	});

	test("listGroups orders by name ascending", async () => {
		const service = groups();
		await service.createGroup({ name: "gamma" });
		await service.createGroup({ name: "alpha" });
		await service.createGroup({ name: "beta" });

		expect((await service.listGroups()).map((row) => row.name)).toEqual(["alpha", "beta", "gamma"]);
	});

	test("setGroupPermissions and groupPermissions round-trip and bump updatedAt", async () => {
		const service = groups();
		const created = await service.createGroup({ name: "Editors" });
		vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));

		await service.setGroupPermissions(created.id, ["resource.books.view", "jobs.manage"]);

		expect(await service.groupPermissions(created.id)).toEqual([
			"resource.books.view",
			"jobs.manage",
		]);
		expect((await service.retrieve(created.id))?.updatedAt).toBe(Date.now());
	});

	test("groupPermissions returns [] for an unknown group", async () => {
		expect(await groups().groupPermissions("missing")).toEqual([]);
	});

	test("groupPermissions returns [] when the stored column is corrupted", async () => {
		const service = groups();
		const created = await service.createGroup({ name: "Editors" });
		await ctx.db
			.update(schema.adminGroups)
			.set({ permissions: "not json" })
			.where(eq(schema.adminGroups.id, created.id));

		expect(await service.groupPermissions(created.id)).toEqual([]);
	});

	test("setUserGroups replaces the previous memberships", async () => {
		const service = groups();
		const alpha = await service.createGroup({ name: "alpha" });
		const beta = await service.createGroup({ name: "beta" });
		const gamma = await service.createGroup({ name: "gamma" });
		await service.setUserGroups("user-1", [alpha.id, beta.id]);

		await service.setUserGroups("user-1", [gamma.id]);

		expect((await service.userGroups("user-1")).map((row) => row.id)).toEqual([gamma.id]);
		expect(await service.groupMembers(alpha.id)).toEqual([]);
		expect(await service.groupMembers(beta.id)).toEqual([]);
	});

	test("setUserGroups deduplicates the given group ids", async () => {
		/** Without deduplication the INSERT would violate the composite primary key. */
		const service = groups();
		const alpha = await service.createGroup({ name: "alpha" });

		await service.setUserGroups("user-1", [alpha.id, alpha.id]);

		expect(await service.groupMembers(alpha.id)).toEqual(["user-1"]);
		expect(await service.userGroups("user-1")).toHaveLength(1);
	});

	test("setUserGroups with an empty array removes every membership", async () => {
		const service = groups();
		const alpha = await service.createGroup({ name: "alpha" });
		await service.setUserGroups("user-1", [alpha.id]);

		await service.setUserGroups("user-1", []);

		expect(await service.userGroups("user-1")).toEqual([]);
		expect(await service.groupMembers(alpha.id)).toEqual([]);
	});

	test("setUserGroups tolerates an unknown group id", async () => {
		const service = groups();
		const alpha = await service.createGroup({ name: "alpha" });

		await service.setUserGroups("user-1", [alpha.id, "missing"]);

		expect((await service.userGroups("user-1")).map((row) => row.id)).toEqual([alpha.id]);
	});

	test("userGroups returns the user's groups ordered by name and omits dangling memberships", async () => {
		const service = groups();
		const beta = await service.createGroup({ name: "beta" });
		const alpha = await service.createGroup({ name: "alpha" });
		await service.setUserGroups("user-1", [beta.id, alpha.id, "missing"]);

		expect((await service.userGroups("user-1")).map((row) => row.name)).toEqual(["alpha", "beta"]);
	});

	test("groupMembers returns member user ids in ascending order", async () => {
		const service = groups();
		const alpha = await service.createGroup({ name: "alpha" });
		await service.setUserGroups("user-2", [alpha.id]);
		await service.setUserGroups("user-1", [alpha.id]);

		expect(await service.groupMembers(alpha.id)).toEqual(["user-1", "user-2"]);
	});

	test("permissionsForUser unions and deduplicates permissions across the user's groups", async () => {
		const service = groups();
		const alpha = await service.createGroup({
			name: "alpha",
			permissions: ["resource.books.view", "audit.view"],
		});
		const beta = await service.createGroup({
			name: "beta",
			permissions: ["audit.view", "jobs.view"],
		});
		await service.setUserGroups("user-1", [beta.id, alpha.id]);

		/** Groups are visited in name order (alpha first), preserving first-seen order. */
		expect(await service.permissionsForUser("user-1")).toEqual([
			"resource.books.view",
			"audit.view",
			"jobs.view",
		]);
	});

	test("permissionsForUser returns [] for a user with no groups", async () => {
		expect(await groups().permissionsForUser("user-1")).toEqual([]);
	});

	test("permissionsForUser ignores dangling memberships", async () => {
		const service = groups();
		await service.setUserGroups("user-1", ["missing"]);

		expect(await service.permissionsForUser("user-1")).toEqual([]);
	});
});
