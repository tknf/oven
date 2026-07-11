/**
 * Tests `AdminPanel`'s `accounts` integration (operator accounts / groups /
 * permission gate; `admin_panel.tsx` + the structural contracts in
 * `admin_types.ts`). Follows the panel testing convention of
 * `admin_panel.test.ts` (session + CSRF cookie/token flow around the built-in
 * login) and the DB setup convention of `sqlite_admin_accounts.test.ts`
 * (`createTestDb` with the fixture schema). The accounts/groups services are
 * the REAL SQLite implementations — never fakes — so this wiring compiling is
 * itself proof that `SQLiteAdminAccounts`/`SQLiteAdminGroups` satisfy
 * `AdminAccountsUsers`/`AdminAccountsGroups`; the other two dialects are
 * covered by the type-level contract test at the bottom.
 *
 * The "TOTP login flow" describe block covers the built-in second login step
 * (`AdminPanel`'s `GET`/`POST "/login/totp"`), against the `adminTotpUsers`
 * fixture table (`test/test_support/fixtures/schema.ts`) via a real
 * `SQLiteAdminAccounts`. It runs under fake time (`vi.useFakeTimers`) so codes
 * generated with `auth/totp.ts#generateTotpCode` land on a known RFC 6238
 * step, matching `sqlite_admin_accounts.test.ts`'s `totp` describe block's
 * convention.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { MySqlQueryResultHKT, PreparedQueryHKTBase } from "drizzle-orm/mysql-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { Env } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { AdminPanel } from "../../src/admin/admin_panel.js";
import type { AdminPanelOptions } from "../../src/admin/admin_panel.js";
import { resourcePermission } from "../../src/admin/admin_permissions.js";
import { AdminResource, fieldsFromTable } from "../../src/admin/admin_resource.js";
import type {
	AdminAccountsGroups,
	AdminAccountsUsers,
	AdminJobRow,
} from "../../src/admin/admin_types.js";
import type {
	MySqlAdminAccounts,
	mysqlAdminUsersTable,
} from "../../src/admin/mysql_admin_accounts.js";
import type {
	MySqlAdminGroups,
	mysqlAdminGroupsTable,
	mysqlAdminUserGroupsTable,
} from "../../src/admin/mysql_admin_groups.js";
import type { PgAdminAccounts, pgAdminUsersTable } from "../../src/admin/pg_admin_accounts.js";
import type {
	PgAdminGroups,
	pgAdminGroupsTable,
	pgAdminUserGroupsTable,
} from "../../src/admin/pg_admin_groups.js";
import { SQLiteAdminAccounts } from "../../src/admin/sqlite_admin_accounts.js";
import { SQLiteAdminGroups } from "../../src/admin/sqlite_admin_groups.js";
import { generateTotpCode } from "../../src/auth/totp.js";
import type { FieldDef } from "../../src/form/form.js";
import { Form } from "../../src/form/form.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { SQLiteModel } from "../../src/model/sqlite_model.js";
import { Csrf } from "../../src/security/csrf.js";
import { RateLimiter } from "../../src/security/rate_limiter.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

type SessionEnv = Env & { Variables: { session: Session } };

/**
 * The session key `AdminPanel` stores the logged-in identity under
 * (`ADMIN_IDENTITY_SESSION_KEY` in `admin_panel.tsx`; not exported, so
 * duplicated here). Used only to hand-craft a legacy session that predates
 * `passwordStamp` (see the "password change invalidates existing sessions"
 * suite below) — every other test drives the identity exclusively through
 * `loginAs`.
 */
const ADMIN_IDENTITY_SESSION_KEY = "__oven_admin_identity__";

/** Extracts only the cookie name=value pair from a `Set-Cookie` header value (same convention as `test/security/csrf.test.ts`). */
const toCookieHeader = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

/** Extracts the CSRF hidden input value from the response HTML. Throws if not found. */
const extractCsrfToken = (html: string): string => {
	const match = html.match(/name="csrf_token" value="([^"]+)"/);
	if (!match?.[1]) throw new Error("csrf_token hidden input not found");
	return match[1];
};

/** Minimal Standard Schema implementation for tests. Same convention as `defineStubSchema` in `test/form/form.test.ts`. */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate,
	},
});

type PublisherInput = { name: string; contactEmail: string; status: string };

/** Real `SQLiteModel` subclass operating on the `publishers` table (same convention as `admin_resource_panel.test.ts`). */
class PublisherModel extends SQLiteModel<
	typeof schema.publishers,
	typeof schema.publishers.id,
	typeof schema
> {
	protected get table() {
		return schema.publishers;
	}
	protected get primaryKey() {
		return schema.publishers.id;
	}
}

/** Admin form for `publishers` that fails validation when `name`/`contactEmail` is empty. */
class PublisherForm extends Form<StandardSchemaV1<unknown, PublisherInput>, string> {
	protected schema() {
		return defineStubSchema<PublisherInput>((value) => {
			const record = value as Record<string, unknown>;
			const issues: StandardSchemaV1.Issue[] = [];
			if (typeof record.name !== "string" || record.name === "") {
				issues.push({ message: "Name is required", path: ["name"] });
			}
			if (typeof record.contactEmail !== "string" || record.contactEmail === "") {
				issues.push({ message: "Contact email is required", path: ["contactEmail"] });
			}
			if (issues.length > 0) return { issues };
			return {
				value: {
					name: record.name as string,
					contactEmail: record.contactEmail as string,
					status: (record.status as string | undefined) ?? "active",
				},
			};
		});
	}
	protected fields(): Record<string, FieldDef> {
		return fieldsFromTable(schema.publishers);
	}
}

/** Writable `publishers` resource. */
class PublisherResource extends AdminResource {
	constructor(private readonly publisherModel: PublisherModel) {
		super();
	}
	get key() {
		return "publishers";
	}
	get label() {
		return "Publisher";
	}
	get model() {
		return this.publisherModel;
	}
	get table() {
		return schema.publishers;
	}
	get primaryKey() {
		return "id";
	}
	form() {
		return new PublisherForm();
	}
}

/** Fake `AdminJobsConsole` used in tests. Records `retryFailed` calls so a denied POST can be proven to never reach the handler. */
const buildFakeJobsConsole = () => {
	const pending: AdminJobRow = {
		id: "job-1",
		name: "SendWelcomeEmail",
		priority: 0,
		runAt: 1700000000000,
		attempts: 0,
		failedAt: null,
		lastError: null,
	};
	const failed: AdminJobRow = {
		...pending,
		id: "job-2",
		failedAt: 1700000001000,
		lastError: "boom",
	};
	const retryFailedCalls: string[] = [];
	return {
		retryFailedCalls,
		listPending: async () => [pending],
		listFailed: async () => [failed],
		retryFailed: async (id: string) => {
			retryFailedCalls.push(id);
			return true;
		},
		deleteJob: async (_id: string) => true,
	};
};

/** Fake `AdminAuditLog` used in tests. Records the entries passed to `record` (same convention as `admin_panel.test.ts`). */
const buildFakeAuditLog = () => {
	const recordCalls: { actor: string; action: string; target: string; changes?: unknown }[] = [];
	return {
		recordCalls,
		list: async () => [],
		record: async (entry: { actor: string; action: string; target: string; changes?: unknown }) => {
			recordCalls.push(entry);
		},
	};
};

/** Minimal fake settings wiring (feature flags + maintenance) so the superuser test can reach `GET /settings`. */
const buildFakeSettings = () => ({
	featureFlags: {
		flags: {
			enabled: async (_name: string) => false,
			enable: async (_name: string) => {},
			disable: async (_name: string) => {},
		},
		names: ["beta"],
	},
	maintenance: {
		enabled: async () => false,
		enable: async () => {},
		disable: async () => {},
	},
});

describe("AdminPanel accounts integration", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	/**
	 * Builds an `AdminPanel` test app wired with session + CSRF + the REAL
	 * SQLite accounts/groups services over the fixture tables, plus the
	 * publishers resource and fake jobs/settings/audit sections. Passing this
	 * `SQLiteAdminAccounts`/`SQLiteAdminGroups` pair to the `accounts` option
	 * compiling without a cast is itself the SQLite contract proof.
	 */
	const buildAccountsApp = (
		overrides: {
			groups?: boolean;
			authorize?: AdminPanelOptions<SessionEnv>["authorize"];
			auth?: AdminPanelOptions<SessionEnv>["auth"];
		} = {},
	) => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
		const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);
		const groups = new SQLiteAdminGroups(ctx.db, {
			groups: schema.adminGroups,
			userGroups: schema.adminUserGroups,
		});
		const audit = buildFakeAuditLog();
		const jobsConsole = buildFakeJobsConsole();

		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				session: sessionAccessor.use,
				csrf,
				accounts: { users, groups: overrides.groups === false ? undefined : groups },
				authorize: overrides.authorize,
				auth: overrides.auth,
				jobs: { console: jobsConsole },
				settings: buildFakeSettings(),
				audit: { log: audit },
				resources: [new PublisherResource(new PublisherModel(ctx.db))],
			}),
		);

		return { app, users, groups, audit, jobsConsole, storage };
	};

	/**
	 * Runs the full built-in login flow: `GET /admin/login` for the session
	 * cookie and CSRF token, then `POST /admin/login` with the credentials.
	 * Returns the login response, the (post-regeneration) session cookie, and
	 * the CSRF token — which stays valid after login because `Session#regenerate`
	 * keeps the session data (including the CSRF secret).
	 */
	const loginAs = async (app: Hono<SessionEnv>, username: string, password: string) => {
		const pageRes = await app.request("/admin/login");
		const pageCookie = pageRes.headers.get("Set-Cookie");
		if (!pageCookie) throw new Error("Set-Cookie was not issued on GET /admin/login");
		const token = extractCsrfToken(await pageRes.text());

		const loginRes = await app.request("/admin/login", {
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				Cookie: toCookieHeader(pageCookie),
			},
			body: new URLSearchParams({ username, password, csrf_token: token }).toString(),
		});
		const loginCookie = loginRes.headers.get("Set-Cookie");
		const cookie = toCookieHeader(loginCookie ?? pageCookie);
		return { loginRes, cookie, token };
	};

	describe("constructor validation", () => {
		test("throws at construction when accounts is injected without session", () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

			expect(() => new AdminPanel<SessionEnv>({ accounts: { users }, csrf })).toThrow(/session/);
		});

		test("throws at construction when accounts is injected without csrf", () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

			expect(
				() => new AdminPanel<SessionEnv>({ accounts: { users }, session: sessionAccessor.use }),
			).toThrow(/csrf/);
		});

		test("throws at construction when neither authorize nor accounts is injected", () => {
			expect(() => new AdminPanel({})).toThrow(/authorize|accounts/);
		});
	});

	describe("derived login", () => {
		test("GET /admin/login renders the derived login form with 200", async () => {
			const { app } = buildAccountsApp();

			const res = await app.request("/admin/login");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain('action="/admin/login"');
			expect(body).toContain('name="username"');
			expect(body).toContain('name="password"');
		});

		test("POST /admin/login with valid account credentials redirects with 303 and authenticates further requests", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });

			const { loginRes, cookie } = await loginAs(app, "alice", "password-1");

			expect(loginRes.status).toBe(303);
			expect(loginRes.headers.get("location")).toBe("/admin");

			const dashboardRes = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(dashboardRes.status).toBe(200);
		});

		test("POST /admin/login with wrong credentials re-renders the form with 401", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });

			const { loginRes } = await loginAs(app, "alice", "wrong-password");

			expect(loginRes.status).toBe(401);
		});
	});

	describe("permission gate", () => {
		test("a superuser can access every wired screen without any explicit permission", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			for (const path of [
				"/admin/resources/publishers",
				"/admin/jobs",
				"/admin/settings",
				"/admin/audit",
			]) {
				const res = await app.request(path, { headers: { Cookie: cookie } });
				expect(res.status).toBe(200);
			}
		});

		test("a non-superuser with only the resource view permission can list but not open the create form", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({
				username: "viewer",
				password: "password-1",
				permissions: [resourcePermission("publishers", "view")],
			});
			const { cookie } = await loginAs(app, "viewer", "password-1");

			const listRes = await app.request("/admin/resources/publishers", {
				headers: { Cookie: cookie },
			});
			expect(listRes.status).toBe(200);

			const newRes = await app.request("/admin/resources/publishers/new", {
				headers: { Cookie: cookie },
			});
			expect(newRes.status).toBe(403);
		});

		test("CSV export shares the resource view permission: granted for a viewer, denied for an operator with no permission", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({
				username: "viewer",
				password: "password-1",
				permissions: [resourcePermission("publishers", "view")],
			});
			await users.createUser({ username: "nobody", password: "password-1" });

			const { cookie: viewerCookie } = await loginAs(app, "viewer", "password-1");
			const viewerRes = await app.request("/admin/resources/publishers/export.csv", {
				headers: { Cookie: viewerCookie },
			});
			expect(viewerRes.status).toBe(200);
			expect(viewerRes.headers.get("content-type")).toContain("text/csv");

			const { cookie: nobodyCookie } = await loginAs(app, "nobody", "password-1");
			const deniedRes = await app.request("/admin/resources/publishers/export.csv", {
				headers: { Cookie: nobodyCookie },
			});
			expect(deniedRes.status).toBe(403);
		});

		test("a non-superuser with only jobs.view can read the jobs screen but not retry a job", async () => {
			const { app, users, jobsConsole } = buildAccountsApp();
			await users.createUser({
				username: "operator",
				password: "password-1",
				permissions: ["jobs.view"],
			});
			const { cookie, token } = await loginAs(app, "operator", "password-1");

			const listRes = await app.request("/admin/jobs", { headers: { Cookie: cookie } });
			expect(listRes.status).toBe(200);

			/** A valid CSRF token is supplied so the 403 can only come from the permission gate. */
			const retryRes = await app.request("/admin/jobs/job-2/retry", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ csrf_token: token }).toString(),
			});
			expect(retryRes.status).toBe(403);
			expect(jobsConsole.retryFailedCalls).toEqual([]);
		});

		test("a non-superuser without audit.view is denied the audit screen", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({
				username: "operator",
				password: "password-1",
				permissions: ["jobs.view"],
			});
			const { cookie } = await loginAs(app, "operator", "password-1");

			const res = await app.request("/admin/audit", { headers: { Cookie: cookie } });

			expect(res.status).toBe(403);
		});

		test("a permission granted only through a group applies via the union", async () => {
			const { app, users, groups } = buildAccountsApp();
			const user = await users.createUser({ username: "member", password: "password-1" });
			const group = await groups.createGroup({
				name: "Viewers",
				permissions: [resourcePermission("publishers", "view")],
			});
			await groups.setUserGroups(user.id, [group.id]);
			const { cookie } = await loginAs(app, "member", "password-1");

			const listRes = await app.request("/admin/resources/publishers", {
				headers: { Cookie: cookie },
			});
			expect(listRes.status).toBe(200);

			const newRes = await app.request("/admin/resources/publishers/new", {
				headers: { Cookie: cookie },
			});
			expect(newRes.status).toBe(403);
		});

		test("an active non-superuser with no permissions can still open the dashboard", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "plain", password: "password-1" });
			const { cookie } = await loginAs(app, "plain", "password-1");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });

			expect(res.status).toBe(200);
		});
	});

	describe("POST /resources/<key> body dispatch", () => {
		test("a create-only operator can submit the create form but not a bulk delete", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({
				username: "creator",
				password: "password-1",
				permissions: [resourcePermission("publishers", "create")],
			});
			const { cookie, token } = await loginAs(app, "creator", "password-1");

			const createRes = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Acme",
					contactEmail: "acme@example.com",
					status: "active",
					csrf_token: token,
				}).toString(),
			});
			expect(createRes.status).toBe(303);
			const rows = await ctx.db.select().from(schema.publishers);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.name).toBe("Acme");

			const bulkRes = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					action: "delete",
					_selected_action: "pub-1",
					csrf_token: token,
				}).toString(),
			});
			expect(bulkRes.status).toBe(403);
		});

		test("a delete-only operator can start a bulk delete but not submit the create form", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({
				username: "deleter",
				password: "password-1",
				permissions: [resourcePermission("publishers", "delete")],
			});
			const { cookie, token } = await loginAs(app, "deleter", "password-1");

			/** No `post=yes` yet, so an allowed bulk delete renders the confirmation screen (200). */
			const bulkRes = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					action: "delete",
					_selected_action: "pub-1",
					csrf_token: token,
				}).toString(),
			});
			expect(bulkRes.status).toBe(200);

			const createRes = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Acme",
					contactEmail: "acme@example.com",
					status: "active",
					csrf_token: token,
				}).toString(),
			});
			expect(createRes.status).toBe(403);
			expect(await ctx.db.select().from(schema.publishers)).toHaveLength(0);
		});
	});

	describe("per-request re-validation", () => {
		test("deactivating a logged-in operator revokes access on the next request", async () => {
			const { app, users } = buildAccountsApp();
			const user = await users.createUser({
				username: "temp",
				password: "password-1",
				isSuperuser: true,
			});
			const { cookie } = await loginAs(app, "temp", "password-1");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);

			await users.updateUser(user.id, { isActive: false });

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("deleting a logged-in operator revokes access on the next request", async () => {
			const { app, users } = buildAccountsApp();
			const user = await users.createUser({
				username: "temp",
				password: "password-1",
				isSuperuser: true,
			});
			const { cookie } = await loginAs(app, "temp", "password-1");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);

			await users.deleteUser(user.id);

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});
	});

	describe("password change invalidates existing sessions", () => {
		test("changing the password logs an already-logged-in session out on its next request", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });
			const { cookie } = await loginAs(app, "alice", "password-1");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);

			const user = await users.findByUsername("alice");
			if (!user) throw new Error("expected alice to exist");
			await users.setPassword(user.id, "password-2");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("a session survives further requests when the password is never changed", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });
			const { cookie } = await loginAs(app, "alice", "password-1");

			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);
		});

		test("a session with no passwordStamp, as issued before this field existed, is rejected", async () => {
			const { app, users, storage } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });
			const { cookie } = await loginAs(app, "alice", "password-1");

			/**
			 * Simulates a session issued by a pre-upgrade `AdminPanel` that never
			 * attached `passwordStamp`: read the identity `loginAs` just stored,
			 * strip the field, and write it back directly through `storage`
			 * (bypassing the panel entirely, since there is no supported way to
			 * produce a stamp-less session through the public API anymore).
			 */
			const session = await storage.get(cookie);
			const identity = session.get(ADMIN_IDENTITY_SESSION_KEY) as { id: string; label?: string };
			session.set(ADMIN_IDENTITY_SESSION_KEY, { id: identity.id, label: identity.label });
			await storage.commit(session);

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("logging in again after a password change restores access", async () => {
			const { app, users } = buildAccountsApp();
			await users.createUser({ username: "alice", password: "password-1" });
			const { cookie: oldCookie } = await loginAs(app, "alice", "password-1");

			const user = await users.findByUsername("alice");
			if (!user) throw new Error("expected alice to exist");
			await users.setPassword(user.id, "password-2");
			expect((await app.request("/admin", { headers: { Cookie: oldCookie } })).status).toBe(302);

			const { loginRes, cookie: newCookie } = await loginAs(app, "alice", "password-2");
			expect(loginRes.status).toBe(303);
			expect((await app.request("/admin", { headers: { Cookie: newCookie } })).status).toBe(200);
		});
	});

	describe("composition with authorize and auth", () => {
		test("an explicit authorize is ANDed with the accounts gate: returning false denies even a superuser", async () => {
			const { app, users } = buildAccountsApp({ authorize: () => false });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });

			expect(res.status).toBe(403);
		});

		test("an explicit auth override wins over the derived login and re-validation still applies to its identity", async () => {
			const seed = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);
			const row = await seed.createUser({
				username: "real",
				password: "password-1",
				isSuperuser: true,
			});
			const { app, users } = buildAccountsApp({
				auth: {
					authenticate: async (_c, { username, password }) =>
						username === "override" && password === "override-secret"
							? { id: row.id, label: "Override" }
							: null,
				},
			});

			/** The derived account credentials must NOT work once `auth` is explicit. */
			const derived = await loginAs(app, "real", "password-1");
			expect(derived.loginRes.status).toBe(401);

			const { cookie } = await loginAs(app, "override", "override-secret");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);

			await users.updateUser(row.id, { isActive: false });
			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});
	});

	describe("audit actor default", () => {
		test("a resource write records the logged-in operator's label as the audit actor when actor is not injected", async () => {
			const { app, users, audit } = buildAccountsApp();
			await users.createUser({
				username: "writer",
				password: "password-1",
				label: "Wendy Writer",
				permissions: [resourcePermission("publishers", "create")],
			});
			const { cookie, token } = await loginAs(app, "writer", "password-1");

			const res = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Acme",
					contactEmail: "acme@example.com",
					status: "active",
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(303);
			expect(audit.recordCalls).toHaveLength(1);
			expect(audit.recordCalls[0]?.action).toBe("resource.create");
			expect(audit.recordCalls[0]?.actor).toBe("Wendy Writer");
		});
	});

	describe("TOTP login flow", () => {
		beforeEach(() => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		/**
		 * Builds an `AdminPanel` test app wired with session + CSRF + a REAL
		 * SQLite accounts service over the TOTP-capable `adminTotpUsers` fixture
		 * table (no groups/jobs/settings/audit/resources — this describe block
		 * only exercises the login flow).
		 */
		const buildTotpApp = (overrides: { rateLimiter?: RateLimiter } = {}) => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminTotpUsers);

			const app = new Hono<SessionEnv>();
			app.use(sessionAccessor.register);
			app.route(
				"/admin",
				new AdminPanel<SessionEnv>({
					session: sessionAccessor.use,
					csrf,
					accounts: { users },
					rateLimiter: overrides.rateLimiter,
				}),
			);

			return { app, users };
		};

		/** Same login-page-then-submit flow as `loginAs`, reused here for the totp-capable app/users pair. */
		const loginAsTotp = async (app: Hono<SessionEnv>, username: string, password: string) => {
			const pageRes = await app.request("/admin/login");
			const pageCookie = pageRes.headers.get("Set-Cookie");
			if (!pageCookie) throw new Error("Set-Cookie was not issued on GET /admin/login");
			const token = extractCsrfToken(await pageRes.text());

			const loginRes = await app.request("/admin/login", {
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					Cookie: toCookieHeader(pageCookie),
				},
				body: new URLSearchParams({ username, password, csrf_token: token }).toString(),
			});
			const loginCookie = loginRes.headers.get("Set-Cookie");
			const cookie = toCookieHeader(loginCookie ?? pageCookie);
			return { loginRes, cookie, token };
		};

		/** Enrolls and confirms TOTP for `userId`, returning the confirmed secret. */
		const enrollAndConfirm = async (
			users: ReturnType<typeof buildTotpApp>["users"],
			userId: string,
		) => {
			const enrollment = await users.beginTotpEnrollment(userId, { issuer: "Oven" });
			if (!enrollment) throw new Error("expected an enrollment");
			const code = await generateTotpCode({ secret: enrollment.secret, timestampMs: Date.now() });
			await users.confirmTotpEnrollment(userId, code);
			return enrollment.secret;
		};

		const submitTotpCode = (app: Hono<SessionEnv>, cookie: string, token: string, code: string) =>
			app.request("/admin/login/totp", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ code, csrf_token: token }).toString(),
			});

		test("a non-enrolled user logs in directly with no totp step", async () => {
			const { app, users } = buildTotpApp();
			await users.createUser({ username: "alice", password: "password-1" });

			const { loginRes, cookie } = await loginAsTotp(app, "alice", "password-1");

			expect(loginRes.status).toBe(303);
			expect(loginRes.headers.get("location")).toBe("/admin");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(200);
		});

		test("an enrolled user's password step redirects to /login/totp, and the identity is not set yet", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await enrollAndConfirm(users, created.id);

			const { loginRes, cookie } = await loginAsTotp(app, "alice", "password-1");

			expect(loginRes.status).toBe(303);
			expect(loginRes.headers.get("location")).toBe("/admin/login/totp");
			/** A protected page still redirects to `/login` — the identity was never set. */
			const dashboardRes = await app.request("/admin", { headers: { Cookie: cookie } });
			expect(dashboardRes.status).toBe(302);
			expect(dashboardRes.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("GET /admin/login/totp renders the code-entry screen", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await enrollAndConfirm(users, created.id);
			const { cookie } = await loginAsTotp(app, "alice", "password-1");

			const res = await app.request("/admin/login/totp", { headers: { Cookie: cookie } });
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain('action="/admin/login/totp"');
			expect(body).toContain('name="code"');
		});

		test("GET /admin/login/totp redirects to /login when there is no pending state", async () => {
			const { app } = buildTotpApp();

			const res = await app.request("/admin/login/totp");

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/login");
		});

		test("POST /admin/login/totp without a CSRF token returns 403, the same as /login", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			const { cookie } = await loginAsTotp(app, "alice", "password-1");
			const code = await generateTotpCode({ secret, timestampMs: Date.now() });

			const res = await app.request("/admin/login/totp", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ code }).toString(),
			});

			expect(res.status).toBe(403);
		});

		test("a wrong code is rejected with 401 and the identity stays unset", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			const { cookie, token } = await loginAsTotp(app, "alice", "password-1");
			const correctCode = await generateTotpCode({ secret, timestampMs: Date.now() });
			const wrongCode = correctCode === "000000" ? "111111" : "000000";

			const res = await submitTotpCode(app, cookie, token, wrongCode);
			const body = await res.text();

			expect(res.status).toBe(401);
			expect(body).toContain("Invalid authentication code.");
			expect((await app.request("/admin", { headers: { Cookie: cookie } })).status).toBe(302);
		});

		test("the correct code completes login, sets the identity, and redirects to next", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			/** Advances past the confirm-time step so this code's step has not already been consumed. */
			vi.setSystemTime(Date.now() + 30_000);
			const code = await generateTotpCode({ secret, timestampMs: Date.now() });
			const { cookie, token } = await loginAsTotp(app, "alice", "password-1");

			const res = await submitTotpCode(app, cookie, token, code);

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin");
			/**
			 * A successful TOTP step regenerates the session id (session-fixation
			 * defense, same as the password step), so the dashboard request must
			 * carry the NEW cookie from this response rather than the one from
			 * `loginAsTotp`'s password step.
			 */
			const postTotpCookie = toCookieHeader(res.headers.get("Set-Cookie") ?? cookie);
			expect((await app.request("/admin", { headers: { Cookie: postTotpCookie } })).status).toBe(
				200,
			);
		});

		test("a replayed code is rejected even against a fresh pending state for the same user", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			vi.setSystemTime(Date.now() + 30_000);
			const code = await generateTotpCode({ secret, timestampMs: Date.now() });

			const first = await loginAsTotp(app, "alice", "password-1");
			expect((await submitTotpCode(app, first.cookie, first.token, code)).status).toBe(303);

			/**
			 * A completely separate session (fresh cookie jar) reaches its own
			 * pending state for the same user, but the replay guard is keyed by
			 * user id, not by session — the same RFC 6238 step is still rejected.
			 */
			const second = await loginAsTotp(app, "alice", "password-1");
			const replayRes = await submitTotpCode(app, second.cookie, second.token, code);

			expect(replayRes.status).toBe(401);
		});

		test("GET /admin/login/totp redirects to /login once the pending state has expired", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			await enrollAndConfirm(users, created.id);
			const { cookie } = await loginAsTotp(app, "alice", "password-1");

			/** `TOTP_PENDING_TTL_MS` in `admin_panel.tsx` is 5 minutes. */
			vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);

			const res = await app.request("/admin/login/totp", { headers: { Cookie: cookie } });

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/login");
		});

		test("POST /admin/login/totp redirects to /login when the pending user was deactivated mid-flow", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			const { cookie, token } = await loginAsTotp(app, "alice", "password-1");
			await users.updateUser(created.id, { isActive: false });
			const code = await generateTotpCode({ secret, timestampMs: Date.now() });

			const res = await submitTotpCode(app, cookie, token, code);

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/login");
		});

		test("POST /admin/login/totp redirects to /login when TOTP was disabled mid-flow", async () => {
			const { app, users } = buildTotpApp();
			const created = await users.createUser({ username: "alice", password: "password-1" });
			const secret = await enrollAndConfirm(users, created.id);
			const { cookie, token } = await loginAsTotp(app, "alice", "password-1");
			await users.disableTotp(created.id);
			const code = await generateTotpCode({ secret, timestampMs: Date.now() });

			const res = await submitTotpCode(app, cookie, token, code);

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/login");
		});

		describe("rate limiting", () => {
			test("an attempt within the limit is checked normally against verifyTotp", async () => {
				const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
				const { app, users } = buildTotpApp({ rateLimiter });
				const created = await users.createUser({ username: "alice", password: "password-1" });
				const secret = await enrollAndConfirm(users, created.id);
				vi.setSystemTime(Date.now() + 30_000);
				const code = await generateTotpCode({ secret, timestampMs: Date.now() });
				const { cookie, token } = await loginAsTotp(app, "alice", "password-1");

				const res = await submitTotpCode(app, cookie, token, code);

				expect(res.status).toBe(303);
			});

			test("an attempt past the limit is rejected with 429 before verifyTotp would even run", async () => {
				const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
				const { app, users } = buildTotpApp({ rateLimiter });
				const created = await users.createUser({ username: "alice", password: "password-1" });
				const secret = await enrollAndConfirm(users, created.id);
				const { cookie, token } = await loginAsTotp(app, "alice", "password-1");
				const correctCode = await generateTotpCode({ secret, timestampMs: Date.now() });
				const wrongCode = correctCode === "000000" ? "111111" : "000000";

				// The built-in budget is 5 attempts per pending user id per window; the first 5
				// go through to `verifyTotp` (and fail on the wrong code), the 6th is rejected up front.
				for (let i = 0; i < 5; i++) {
					const res = await submitTotpCode(app, cookie, token, wrongCode);
					expect(res.status).toBe(401);
				}
				const res = await submitTotpCode(app, cookie, token, wrongCode);
				const body = await res.text();

				expect(res.status).toBe(429);
				expect(body).toContain("Too many attempts. Try again later.");
			});

			test("a successful totp login resets the rate limit budget for that user", async () => {
				const rateLimiter = new RateLimiter(new InMemoryKeyValueStore());
				const { app, users } = buildTotpApp({ rateLimiter });
				const created = await users.createUser({ username: "alice", password: "password-1" });
				const secret = await enrollAndConfirm(users, created.id);
				vi.setSystemTime(Date.now() + 30_000);
				const code = await generateTotpCode({ secret, timestampMs: Date.now() });
				const { cookie, token } = await loginAsTotp(app, "alice", "password-1");
				const wrongCode = code === "000000" ? "111111" : "000000";

				// Burn 4 of the 5-attempt budget with wrong codes, then succeed on the 5th attempt.
				for (let i = 0; i < 4; i++) {
					expect((await submitTotpCode(app, cookie, token, wrongCode)).status).toBe(401);
				}
				expect((await submitTotpCode(app, cookie, token, code)).status).toBe(303);

				/** A fresh pending state for the same user is not immediately blocked — the budget was reset. */
				const second = await loginAsTotp(app, "alice", "password-1");
				const freshRes = await submitTotpCode(app, second.cookie, second.token, wrongCode);
				expect(freshRes.status).toBe(401);
			});
		});
	});

	test("all three dialects' default-table services satisfy the accounts contracts (type-level)", () => {
		/**
		 * Never invoked — compiling is the assertion. Each parameter is a dialect
		 * service instantiated at its default-table type (the fixture tables ARE
		 * the SQLite defaults), and the body assigns them to the structural
		 * contracts `AdminPanel` consumes, so a signature drift in any dialect
		 * breaks this file's typecheck.
		 */
		const assertContracts = (
			sqliteUsers: SQLiteAdminAccounts<typeof schema.adminUsers>,
			pgUsers: PgAdminAccounts<ReturnType<typeof pgAdminUsersTable>, PgQueryResultHKT>,
			mysqlUsers: MySqlAdminAccounts<
				ReturnType<typeof mysqlAdminUsersTable>,
				MySqlQueryResultHKT,
				PreparedQueryHKTBase
			>,
			sqliteGroups: SQLiteAdminGroups<typeof schema.adminGroups, typeof schema.adminUserGroups>,
			pgGroups: PgAdminGroups<
				ReturnType<typeof pgAdminGroupsTable>,
				ReturnType<typeof pgAdminUserGroupsTable>,
				PgQueryResultHKT
			>,
			mysqlGroups: MySqlAdminGroups<
				ReturnType<typeof mysqlAdminGroupsTable>,
				ReturnType<typeof mysqlAdminUserGroupsTable>,
				MySqlQueryResultHKT,
				PreparedQueryHKTBase
			>,
		): { users: AdminAccountsUsers[]; groups: AdminAccountsGroups[] } => ({
			users: [sqliteUsers, pgUsers, mysqlUsers],
			groups: [sqliteGroups, pgGroups, mysqlGroups],
		});

		expect(assertContracts).toBeTypeOf("function");
	});
});
