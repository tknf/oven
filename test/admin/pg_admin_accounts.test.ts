/**
 * Tests `PgAdminAccounts` (the Postgres version of admin-panel operator accounts;
 * `src/admin/pg_admin_accounts.ts`). Verifies the same aspects as
 * `test/admin/sqlite_admin_accounts.test.ts` using PGlite (an in-process WASM
 * Postgres), the `adminUsers` table in `test/test_support/fixtures/pg_schema.ts`,
 * and `pg_migrations` (the same harness as `test/audit/pg_audit_log.test.ts`).
 * The extension-recipe tests stay SQLite-only (the extended fixture table exists
 * only in the SQLite fixture schema).
 */
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { LastActiveSuperuserError } from "../../src/admin/admin_accounts_errors.js";
import { PgAdminAccounts } from "../../src/admin/pg_admin_accounts.js";
import { verifyPassword } from "../../src/auth/password.js";
import * as schema from "../test_support/fixtures/pg_schema.js";

const migrationsFolder = new URL("../test_support/fixtures/pg_migrations", import.meta.url)
	.pathname;

/** Creates an independent in-memory PGlite client per test, applies migrations, then returns it. */
const createTestDb = async () => {
	const client = new PGlite();
	const db = drizzle(client, { schema });
	await migrate(db, { migrationsFolder });
	return { client, db };
};

describe("PgAdminAccounts", () => {
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

	const accounts = () => new PgAdminAccounts(ctx.db, schema.adminUsers);

	test("createUser hashes the password and applies defaults", async () => {
		const users = accounts();

		const row = await users.createUser({ username: "alice", password: "password-1" });

		expect(row.username).toBe("alice");
		expect(row.passwordHash).not.toBe("password-1");
		expect(row.passwordHash).toMatch(/^pbkdf2\$/);
		expect(await verifyPassword("password-1", row.passwordHash)).toBe(true);
		expect(row.permissions).toBe("[]");
		expect(row.isActive).toBe(true);
		expect(row.isSuperuser).toBe(false);
		expect(row.lastLoginAt).toBeNull();
		expect(row.createdAt).toBe(Date.now());
		expect(row.updatedAt).toBe(Date.now());
	});

	test("createUser normalizes the username and enforces uniqueness case-insensitively", async () => {
		const users = accounts();

		const row = await users.createUser({ username: "  Alice ", password: "password-1" });

		expect(row.username).toBe("alice");
		expect(await users.findByUsername("alice")).toBeDefined();
		expect(await users.findByUsername(" ALICE ")).toBeDefined();
		await expect(users.createUser({ username: "ALICE", password: "password-2" })).rejects.toThrow(
			'username "alice" is already taken',
		);
	});

	test("createUser rejects an empty username", async () => {
		await expect(
			accounts().createUser({ username: "   ", password: "password-1" }),
		).rejects.toThrow("username must not be empty");
	});

	test("createUser rejects a password shorter than the default minimum of 8", async () => {
		await expect(accounts().createUser({ username: "alice", password: "1234567" })).rejects.toThrow(
			"password must be at least 8 characters",
		);
	});

	test("createUser respects a custom minPasswordLength", async () => {
		const users = new PgAdminAccounts(ctx.db, schema.adminUsers, { minPasswordLength: 4 });

		const row = await users.createUser({ username: "alice", password: "abcd" });

		expect(await verifyPassword("abcd", row.passwordHash)).toBe(true);
		await expect(users.createUser({ username: "bob", password: "abc" })).rejects.toThrow(
			"password must be at least 4 characters",
		);
	});

	test("createUser rejects a password longer than 1024 characters", async () => {
		await expect(
			accounts().createUser({ username: "alice", password: "a".repeat(1025) }),
		).rejects.toThrow("password must be at most 1024 characters");
	});

	test("createUser stores the given permissions as JSON", async () => {
		const users = accounts();

		const row = await users.createUser({
			username: "alice",
			password: "password-1",
			permissions: ["resource.items.view", "audit.view"],
		});

		expect(row.permissions).toBe(JSON.stringify(["resource.items.view", "audit.view"]));
		expect(await users.userPermissions(row.id)).toEqual(["resource.items.view", "audit.view"]);
	});

	test("authenticate returns the row and sets lastLoginAt without touching updatedAt", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });
		vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));

		const authed = await users.authenticate({ username: "alice", password: "password-1" });

		expect(authed).not.toBeNull();
		expect(authed?.lastLoginAt).toBe(Date.now());
		const persisted = await users.retrieve(created.id);
		expect(persisted?.lastLoginAt).toBe(Date.now());
		expect(persisted?.updatedAt).toBe(created.updatedAt);
	});

	test("authenticate returns null for a wrong password", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1" });

		expect(await users.authenticate({ username: "alice", password: "password-2" })).toBeNull();
	});

	test("authenticate returns null for an over-length password without hashing it", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1" });

		expect(await users.authenticate({ username: "alice", password: "a".repeat(2000) })).toBeNull();
	});

	test("authenticate returns null for an unknown username", async () => {
		expect(
			await accounts().authenticate({ username: "nobody", password: "password-1" }),
		).toBeNull();
	});

	test("authenticate returns null for an inactive user even with the correct password", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });
		await users.updateUser(created.id, { isActive: false });

		expect(await users.authenticate({ username: "alice", password: "password-1" })).toBeNull();
	});

	test("authenticate accepts a username in a different case", async () => {
		const users = accounts();
		await users.createUser({ username: "Bob", password: "password-1" });

		const authed = await users.authenticate({ username: "BOB", password: "password-1" });

		expect(authed?.username).toBe("bob");
	});

	test("setPassword replaces the password", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });

		await users.setPassword(created.id, "password-2");

		expect(await users.authenticate({ username: "alice", password: "password-1" })).toBeNull();
		expect(await users.authenticate({ username: "alice", password: "password-2" })).not.toBeNull();
	});

	test("setPassword rejects a too-short password", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });

		await expect(users.setPassword(created.id, "1234567")).rejects.toThrow(
			"password must be at least 8 characters",
		);
	});

	test("updateUser updates profile fields and bumps updatedAt", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });
		vi.setSystemTime(new Date("2026-07-06T01:00:00.000Z"));

		const updated = await users.updateUser(created.id, {
			label: "Site admin",
			isActive: false,
			isSuperuser: true,
		});

		expect(updated?.label).toBe("Site admin");
		expect(updated?.isActive).toBe(false);
		expect(updated?.isSuperuser).toBe(true);
		expect(updated?.updatedAt).toBe(Date.now());
		expect(updated?.updatedAt).not.toBe(created.updatedAt);
	});

	test("updateUser rejects renaming to an existing username but allows a self-rename", async () => {
		const users = accounts();
		const alice = await users.createUser({ username: "alice", password: "password-1" });
		const bob = await users.createUser({ username: "bob", password: "password-1" });

		await expect(users.updateUser(bob.id, { username: "ALICE" })).rejects.toThrow(
			'username "alice" is already taken',
		);
		const selfRenamed = await users.updateUser(alice.id, { username: "ALICE" });
		expect(selfRenamed?.username).toBe("alice");
	});

	test("updateUser normalizes the new username", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });

		const updated = await users.updateUser(created.id, { username: "  Carol " });

		expect(updated?.username).toBe("carol");
		expect(await users.findByUsername("CAROL")).toBeDefined();
	});

	test("updateUser returns undefined for an unknown id", async () => {
		expect(await accounts().updateUser("missing", { label: "x" })).toBeUndefined();
	});

	test("setUserPermissions and userPermissions round-trip", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });

		await users.setUserPermissions(created.id, ["resource.items.view", "jobs.manage"]);

		expect(await users.userPermissions(created.id)).toEqual(["resource.items.view", "jobs.manage"]);
	});

	test("userPermissions returns [] for an unknown user", async () => {
		expect(await accounts().userPermissions("missing")).toEqual([]);
	});

	test("userPermissions returns [] when the stored column is corrupted", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });
		await ctx.db
			.update(schema.adminUsers)
			.set({ permissions: "not json" })
			.where(eq(schema.adminUsers.id, created.id));

		expect(await users.userPermissions(created.id)).toEqual([]);
	});

	test("listUsers matches username and label and orders by username", async () => {
		const users = accounts();
		await users.createUser({ username: "carol", password: "password-1" });
		await users.createUser({ username: "alice", password: "password-1", label: "Site admin" });
		await users.createUser({ username: "bob", password: "password-1", label: "Ops" });

		expect((await users.listUsers()).map((row) => row.username)).toEqual(["alice", "bob", "carol"]);
		expect((await users.listUsers({ query: "ali" })).map((row) => row.username)).toEqual(["alice"]);
		expect((await users.listUsers({ query: "Ops" })).map((row) => row.username)).toEqual(["bob"]);
	});

	test("listUsers does not treat a literal % in the query as a wildcard", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1" });
		await users.createUser({ username: "100%done", password: "password-1" });

		expect((await users.listUsers({ query: "%" })).map((row) => row.username)).toEqual([
			"100%done",
		]);
	});

	test("listUsers applies limit and offset", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1" });
		await users.createUser({ username: "bob", password: "password-1" });
		await users.createUser({ username: "carol", password: "password-1" });

		expect((await users.listUsers({ limit: 2 })).map((row) => row.username)).toEqual([
			"alice",
			"bob",
		]);
		expect((await users.listUsers({ limit: 2, offset: 2 })).map((row) => row.username)).toEqual([
			"carol",
		]);
	});

	test("count counts all users or those matching the query", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1", label: "Site admin" });
		await users.createUser({ username: "bob", password: "password-1" });

		expect(await users.count()).toBe(2);
		expect(await users.count("ali")).toBe(1);
		expect(await users.count("nobody")).toBe(0);
	});

	test("countActiveSuperusers counts only active superusers", async () => {
		const users = accounts();
		await users.createUser({ username: "alice", password: "password-1", isSuperuser: true });
		await users.createUser({
			username: "bob",
			password: "password-1",
			isSuperuser: true,
			isActive: false,
		});
		await users.createUser({ username: "carol", password: "password-1" });

		expect(await users.countActiveSuperusers()).toBe(1);
	});

	test("deleteUser removes the row", async () => {
		const users = accounts();
		const created = await users.createUser({ username: "alice", password: "password-1" });

		await users.deleteUser(created.id);

		expect(await users.retrieve(created.id)).toBeUndefined();
		expect(await users.count()).toBe(0);
	});

	describe("protectLastActiveSuperuser", () => {
		test("updateUser rejects demoting the only active superuser and leaves the row unchanged", async () => {
			const users = accounts();
			const created = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});

			await expect(
				users.updateUser(created.id, { isSuperuser: false }, { protectLastActiveSuperuser: true }),
			).rejects.toThrow(LastActiveSuperuserError);
			const persisted = await users.retrieve(created.id);
			expect(persisted?.isSuperuser).toBe(true);
			expect(persisted?.updatedAt).toBe(created.updatedAt);
		});

		test("updateUser rejects deactivating the only active superuser and leaves the row unchanged", async () => {
			const users = accounts();
			const created = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});

			await expect(
				users.updateUser(created.id, { isActive: false }, { protectLastActiveSuperuser: true }),
			).rejects.toThrow(LastActiveSuperuserError);
			const persisted = await users.retrieve(created.id);
			expect(persisted?.isActive).toBe(true);
			expect(persisted?.updatedAt).toBe(created.updatedAt);
		});

		test("updateUser allows demoting one of two active superusers", async () => {
			const users = accounts();
			const alice = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});
			await users.createUser({ username: "bob", password: "password-1", isSuperuser: true });

			const updated = await users.updateUser(
				alice.id,
				{ isSuperuser: false },
				{ protectLastActiveSuperuser: true },
			);

			expect(updated?.isSuperuser).toBe(false);
		});

		test("updateUser allows updating a non-superuser even with the guard on", async () => {
			const users = accounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });

			const updated = await users.updateUser(
				created.id,
				{ label: "Ops" },
				{ protectLastActiveSuperuser: true },
			);

			expect(updated?.label).toBe("Ops");
		});

		test("deleteUser rejects deleting the only active superuser and leaves the row in place", async () => {
			const users = accounts();
			const created = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});

			await expect(
				users.deleteUser(created.id, { protectLastActiveSuperuser: true }),
			).rejects.toThrow(LastActiveSuperuserError);
			expect(await users.retrieve(created.id)).toBeDefined();
		});

		test("deleteUser allows deleting one of two active superusers", async () => {
			const users = accounts();
			const alice = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});
			await users.createUser({ username: "bob", password: "password-1", isSuperuser: true });

			await users.deleteUser(alice.id, { protectLastActiveSuperuser: true });

			expect(await users.retrieve(alice.id)).toBeUndefined();
		});

		test("updateUser on an unknown id returns undefined instead of throwing", async () => {
			const users = accounts();

			expect(
				await users.updateUser(
					"missing",
					{ isSuperuser: false },
					{ protectLastActiveSuperuser: true },
				),
			).toBeUndefined();
		});

		test("deleteUser on an unknown id is a no-op instead of throwing", async () => {
			const users = accounts();

			await expect(
				users.deleteUser("missing", { protectLastActiveSuperuser: true }),
			).resolves.toBeUndefined();
		});

		test("without the option, the only active superuser can still be demoted and deleted", async () => {
			const users = accounts();
			const alice = await users.createUser({
				username: "alice",
				password: "password-1",
				isSuperuser: true,
			});
			const bob = await users.createUser({
				username: "bob",
				password: "password-1",
				isSuperuser: true,
			});

			const demoted = await users.updateUser(alice.id, { isSuperuser: false });
			expect(demoted?.isSuperuser).toBe(false);
			await users.deleteUser(bob.id);
			expect(await users.retrieve(bob.id)).toBeUndefined();
		});
	});
});
