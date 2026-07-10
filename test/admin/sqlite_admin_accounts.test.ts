/**
 * Tests `SQLiteAdminAccounts` (admin-panel operator accounts backed by a Drizzle
 * sqlite-core table; `src/admin/sqlite_admin_accounts.ts`). Uses `createTestDb`
 * (`src/test/db.ts`) with this repo's minimal fixture schema (the `adminUsers`,
 * `adminOperators`, and `adminLockoutUsers` tables in
 * `test/test_support/fixtures/schema.ts`), following the same approach as
 * `test/audit/sqlite_audit_log.test.ts`. The `lockout` describe block covers
 * `SQLiteAdminAccountsOptions#lockout` and `unlockUser` (opt-in failed-attempt
 * account lockout).
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { LastActiveSuperuserError } from "../../src/admin/admin_accounts_errors.js";
import { SQLiteAdminAccounts } from "../../src/admin/sqlite_admin_accounts.js";
import type {
	SQLiteAdminAccountsCreateUserInput,
	SQLiteAdminAccountsUpdateUserPatch,
	SQLiteAdminUserLockoutRecordTable,
	SQLiteAdminUserRecordTable,
} from "../../src/admin/sqlite_admin_accounts.js";
import { verifyPassword } from "../../src/auth/password.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

describe("SQLiteAdminAccounts", () => {
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

	const accounts = () => new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

	test("the extended fixture table satisfies the structural contract (type-level)", () => {
		/**
		 * `satisfies` fails compilation if the spread-extended table (extra `email`
		 * column) stops matching the contract; the runtime assertion is a formality.
		 */
		const table = schema.adminOperators satisfies SQLiteAdminUserRecordTable;
		expect(table).toBe(schema.adminOperators);
	});

	test("the lockout fixture table satisfies the lockout structural contract (type-level)", () => {
		/**
		 * `satisfies` fails compilation if the spread-extended table (lockout
		 * columns) stops matching the contract; the runtime assertion is a formality.
		 */
		const table = schema.adminLockoutUsers satisfies SQLiteAdminUserLockoutRecordTable;
		expect(table).toBe(schema.adminLockoutUsers);
	});

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
		const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers, { minPasswordLength: 4 });

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

	test("an extended table types and stores its extra columns", async () => {
		const operators = new SQLiteAdminAccounts(ctx.db, schema.adminOperators);

		/** `email` is required here by the type of `createUser` (the point of the extension recipe). */
		const created = await operators.createUser({
			username: "op",
			password: "password-1",
			email: "op@example.com",
		});

		expect(created.email).toBe("op@example.com");
		const authed = await operators.authenticate({ username: "OP", password: "password-1" });
		expect(authed?.email).toBe("op@example.com");
		expect(await operators.userPermissions(created.id)).toEqual([]);
	});

	describe("lockout", () => {
		const lockoutOptions = { maxAttempts: 3, lockDurationSeconds: 60 };
		const lockoutAccounts = (lockout = lockoutOptions) =>
			new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers, { lockout });

		test("a wrong password increments failedAttempts without locking below the threshold", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			expect(created.failedAttempts).toBe(0);

			await users.authenticate({ username: "alice", password: "wrong" });

			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(1);
			expect(persisted?.lockedUntil).toBeNull();
		});

		test("reaching maxAttempts locks the account for lockDurationSeconds", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });

			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });

			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(3);
			expect(persisted?.lockedUntil).toBe(Date.now() + 60_000);
		});

		test("a locked account rejects the correct password too (enumeration-safe null)", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });

			const authed = await users.authenticate({ username: "alice", password: "password-1" });

			expect(authed).toBeNull();
			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(3);
		});

		test("a locked account rejects a wrong password without any further writes", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			const lockedState = await users.retrieve(created.id);

			const authed = await users.authenticate({ username: "alice", password: "still-wrong" });

			expect(authed).toBeNull();
			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(lockedState?.failedAttempts);
			expect(persisted?.lockedUntil).toBe(lockedState?.lockedUntil);
		});

		test("an expired lock stops blocking and a successful login resets the counter", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			vi.setSystemTime(new Date(Date.now() + 61_000));

			const authed = await users.authenticate({ username: "alice", password: "password-1" });

			expect(authed).not.toBeNull();
			expect(authed?.failedAttempts).toBe(0);
			expect(authed?.lockedUntil).toBeNull();
			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(0);
			expect(persisted?.lockedUntil).toBeNull();
		});

		test("a successful login below the threshold resets the counter", async () => {
			const users = lockoutAccounts();
			await users.createUser({ username: "alice", password: "password-1" });
			await users.authenticate({ username: "alice", password: "wrong" });

			const authed = await users.authenticate({ username: "alice", password: "password-1" });

			expect(authed?.failedAttempts).toBe(0);
		});

		test("unlockUser clears the lockout state and allows login again", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });

			await users.unlockUser(created.id);

			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(0);
			expect(persisted?.lockedUntil).toBeNull();
			const authed = await users.authenticate({ username: "alice", password: "password-1" });
			expect(authed).not.toBeNull();
		});

		test("unlockUser on a missing user is a no-op", async () => {
			const users = lockoutAccounts();
			await expect(users.unlockUser("missing")).resolves.toBeUndefined();
		});

		test("unlockUser works off column presence alone, independent of the lockout option", async () => {
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers);
			const created = await users.createUser({ username: "alice", password: "password-1" });

			await expect(users.unlockUser(created.id)).resolves.toBeUndefined();
			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(0);
			expect(persisted?.lockedUntil).toBeNull();
		});

		test("unlockUser throws when the table has no lockout columns", async () => {
			await expect(accounts().unlockUser("whatever")).rejects.toThrow(
				"spread sqliteAdminUserLockoutColumns()",
			);
		});

		test("the constructor rejects a maxAttempts below 1", () => {
			expect(
				() =>
					new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers, {
						lockout: { maxAttempts: 0, lockDurationSeconds: 60 },
					}),
			).toThrow("lockout.maxAttempts must be at least 1");
		});

		test("the constructor rejects a lockDurationSeconds below 1", () => {
			expect(
				() =>
					new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers, {
						lockout: { maxAttempts: 3, lockDurationSeconds: 0 },
					}),
			).toThrow("lockout.lockDurationSeconds must be at least 1");
		});

		test("the constructor rejects lockout on a table without the lockout columns", () => {
			expect(
				() => new SQLiteAdminAccounts(ctx.db, schema.adminUsers, { lockout: lockoutOptions }),
			).toThrow("spread sqliteAdminUserLockoutColumns()");
		});

		test("createUser strips failedAttempts/lockedUntil smuggled through extra input", async () => {
			const users = lockoutAccounts();
			const smuggled = {
				username: "alice",
				password: "password-1",
				failedAttempts: 999,
				lockedUntil: Date.now() + 999_000,
			};

			const created = await users.createUser(
				smuggled as SQLiteAdminAccountsCreateUserInput<typeof schema.adminLockoutUsers>,
			);

			expect(created.failedAttempts).toBe(0);
			expect(created.lockedUntil).toBeNull();
		});

		test("updateUser strips failedAttempts/lockedUntil smuggled through extra input", async () => {
			const users = lockoutAccounts();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const smuggled = { label: "Ops", failedAttempts: 999, lockedUntil: Date.now() + 999_000 };

			const updated = await users.updateUser(
				created.id,
				smuggled as SQLiteAdminAccountsUpdateUserPatch<typeof schema.adminLockoutUsers>,
			);

			expect(updated?.label).toBe("Ops");
			expect(updated?.failedAttempts).toBe(0);
			expect(updated?.lockedUntil).toBeNull();
		});

		test("without the lockout option, authenticate never reads or writes the lockout columns", async () => {
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers);
			const created = await users.createUser({ username: "alice", password: "password-1" });

			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });
			await users.authenticate({ username: "alice", password: "wrong" });

			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(0);
			expect(persisted?.lockedUntil).toBeNull();
		});

		test("without the lockout option, a successful login does not reset pre-existing lockout state", async () => {
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminLockoutUsers);
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await ctx.db
				.update(schema.adminLockoutUsers)
				.set({ failedAttempts: 2 })
				.where(eq(schema.adminLockoutUsers.id, created.id));

			const authed = await users.authenticate({ username: "alice", password: "password-1" });

			expect(authed).not.toBeNull();
			expect(authed?.failedAttempts).toBe(2);
			expect(authed?.lockedUntil).toBeNull();
			const persisted = await users.retrieve(created.id);
			expect(persisted?.failedAttempts).toBe(2);
			expect(persisted?.lockedUntil).toBeNull();
		});
	});
});
