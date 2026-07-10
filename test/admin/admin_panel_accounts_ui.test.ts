/**
 * Tests `AdminPanel`'s superuser-only operator accounts management screen
 * (`/accounts/users*`; `admin_panel.tsx`'s `wireAccounts`). Follows the DB and
 * session/CSRF setup convention of `admin_panel_accounts.test.ts` (real
 * `SQLiteAdminAccounts`/`SQLiteAdminGroups` over the fixture tables, the
 * built-in login flow via `loginAs`).
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Env } from "hono";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { AdminPanel } from "../../src/admin/admin_panel.js";
import type { AdminIdentity, AdminPanelOptions } from "../../src/admin/admin_panel.js";
import {
	ADMIN_BUILTIN_PERMISSIONS,
	resourcePermission,
} from "../../src/admin/admin_permissions.js";
import { AdminResource, fieldsFromTable } from "../../src/admin/admin_resource.js";
import type { AdminJobRow } from "../../src/admin/admin_types.js";
import { SQLiteAdminAccounts } from "../../src/admin/sqlite_admin_accounts.js";
import { SQLiteAdminGroups } from "../../src/admin/sqlite_admin_groups.js";
import type { FieldDef } from "../../src/form/form.js";
import { Form } from "../../src/form/form.js";
import { SQLiteModel } from "../../src/model/sqlite_model.js";
import { Csrf } from "../../src/security/csrf.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

type SessionEnv = Env & { Variables: { session: Session } };

/** Extracts only the cookie name=value pair from a `Set-Cookie` header value (same convention as `admin_panel_accounts.test.ts`). */
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

/**
 * Extracts the `#nav-sidebar` section's inner HTML (`admin_layout.tsx`'s
 * `buildNav` output), so nav-filtering assertions don't false-positive on an
 * unrelated occurrence of the same href elsewhere on the page (e.g. the
 * dashboard's own unfiltered "Resources" listing). Throws if not found.
 */
const extractNav = (html: string): string => {
	const match = html.match(/<nav id="nav-sidebar"[^>]*>([\s\S]*?)<\/nav>/);
	if (!match?.[1]) throw new Error("#nav-sidebar not found");
	return match[1];
};

/**
 * Extracts the `#content` section's inner HTML (the dashboard's resource-list
 * module and every other screen's main content), the body-side counterpart to
 * `extractNav` above — used so dashboard-body assertions don't false-positive
 * on the (separately filtered) `#nav-sidebar`. Throws if not found.
 */
const extractContent = (html: string): string => {
	const match = html.match(/<main id="content"[^>]*>([\s\S]*)<\/main>/);
	if (!match?.[1]) throw new Error("#content not found");
	return match[1];
};

/** Fake `AdminAuditLog` used in tests. Records the entries passed to `record` (same convention as `admin_panel_accounts.test.ts`). */
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

/** Fake `AdminJobsConsole` used in the nav-filtering tests below (same convention as `admin_panel_accounts.test.ts`). */
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
	return {
		listPending: async () => [pending],
		listFailed: async () => [],
		retryFailed: async (_id: string) => true,
		deleteJob: async (_id: string) => true,
	};
};

/** Minimal fake settings wiring (feature flags + maintenance) so `GET /settings` has something to render. */
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

/** Read-only `Model` over the fixture `publishers` table, for the nav-filtering tests' resource section. */
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

/** View-only `publishers` resource (no `form()`) — enough to exercise `buildNav`'s `resource.<key>.view` filter. */
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
}

/** Read-only `Model` over the fixture `books` table — a second, independent resource for the dashboard-filtering tests below. */
class BookModel extends SQLiteModel<typeof schema.books, typeof schema.books.id, typeof schema> {
	protected get table() {
		return schema.books;
	}
	protected get primaryKey() {
		return schema.books.id;
	}
}

/** View-only `books` resource (no `form()`), paired with `PublisherResource` to prove per-resource dashboard filtering. */
class BookResource extends AdminResource {
	constructor(private readonly bookModel: BookModel) {
		super();
	}
	get key() {
		return "books";
	}
	get label() {
		return "Book";
	}
	get model() {
		return this.bookModel;
	}
	get table() {
		return schema.books;
	}
	get primaryKey() {
		return "id";
	}
}

describe("AdminPanel accounts management UI", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
	});

	afterEach(() => {
		ctx.client.close();
	});

	/**
	 * Builds an `AdminPanel` test app wired with session + CSRF + the REAL
	 * SQLite accounts/groups services, same convention as
	 * `admin_panel_accounts.test.ts`'s `buildAccountsApp`. `withNavSections`
	 * additionally wires jobs/settings/a `publishers` resource (on top of the
	 * always-on `audit`), so the nav-filtering tests below have every
	 * non-superuser-only section available to filter.
	 */
	const buildApp = (options: { groups?: boolean; withNavSections?: boolean } = {}) => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
		const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);
		const groups = new SQLiteAdminGroups(ctx.db, {
			groups: schema.adminGroups,
			userGroups: schema.adminUserGroups,
		});
		const audit = buildFakeAuditLog();

		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				session: sessionAccessor.use,
				csrf,
				accounts: { users, groups: options.groups === false ? undefined : groups },
				audit: { log: audit },
				...(options.withNavSections
					? {
							jobs: { console: buildFakeJobsConsole() },
							settings: buildFakeSettings(),
							resources: [
								new PublisherResource(new PublisherModel(ctx.db)),
								new BookResource(new BookModel(ctx.db)),
							],
						}
					: {}),
			}),
		);

		return { app, users, groups, audit };
	};

	/** Runs the full built-in login flow (same convention as `admin_panel_accounts.test.ts`'s `loginAs`). */
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

	describe("superuser-only gate", () => {
		test("a non-superuser is denied even with every built-in permission granted", async () => {
			const { app, users } = buildApp();
			await users.createUser({
				username: "operator",
				password: "password-1",
				permissions: [...ADMIN_BUILTIN_PERMISSIONS],
			});
			const { cookie } = await loginAs(app, "operator", "password-1");

			const res = await app.request("/admin/accounts/users", { headers: { Cookie: cookie } });

			expect(res.status).toBe(403);
		});

		test("a superuser can open the users list", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin/accounts/users", { headers: { Cookie: cookie } });

			expect(res.status).toBe(200);
		});
	});

	describe("pagination", () => {
		test("?p=1 shows the second page's users, and the paginator marks it as current", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			for (let i = 1; i <= 25; i++) {
				const n = String(i).padStart(2, "0");
				await users.createUser({ username: `member-${n}`, password: "password-123" });
			}
			const { cookie } = await loginAs(app, "root", "password-1");

			const firstPage = await app.request("/admin/accounts/users", { headers: { Cookie: cookie } });
			const secondPage = await app.request("/admin/accounts/users?p=1", {
				headers: { Cookie: cookie },
			});
			const firstBody = await firstPage.text();
			const secondBody = await secondPage.text();

			// Users are listed alphabetically ascending, so "member-01".."member-20"
			// fill the first page and "member-21".."member-25" plus "root" spill
			// onto the second.
			expect(firstBody).toContain("member-01");
			expect(firstBody).not.toContain("member-21");
			expect(secondBody).toContain("member-21");
			expect(secondBody).not.toContain("member-01");
			expect(secondBody).toContain('class="paginator"');
			expect(secondBody).toContain('aria-current="page"');
		});
	});

	describe("nav visibility", () => {
		test("a superuser's dashboard nav includes the Accounts link", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const body = await res.text();

			expect(body).toContain('href="/admin/accounts/users"');
		});

		test("a non-superuser's dashboard nav has no Accounts link", async () => {
			const { app, users } = buildApp();
			await users.createUser({
				username: "operator",
				password: "password-1",
				permissions: [...ADMIN_BUILTIN_PERMISSIONS],
			});
			const { cookie } = await loginAs(app, "operator", "password-1");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const body = await res.text();

			expect(body).not.toContain('href="/admin/accounts/users"');
		});
	});

	describe("nav filtering by granted permissions", () => {
		test("a non-superuser with only jobs.view sees Jobs but not Settings, Audit, or the resource link", async () => {
			const { app, users } = buildApp({ withNavSections: true });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			await users.createUser({
				username: "operator",
				password: "password-2",
				permissions: ["jobs.view"],
			});
			const { cookie } = await loginAs(app, "operator", "password-2");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const nav = extractNav(await res.text());

			expect(nav).toContain('href="/admin/jobs"');
			expect(nav).not.toContain('href="/admin/settings"');
			expect(nav).not.toContain('href="/admin/audit"');
			expect(nav).not.toContain('href="/admin/resources/publishers"');
		});

		test("a non-superuser granted settings.view only through a group sees Settings", async () => {
			const { app, users, groups } = buildApp({ withNavSections: true });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const operator = await users.createUser({ username: "operator", password: "password-2" });
			const group = await groups.createGroup({ name: "Settings viewers" });
			await groups.setGroupPermissions(group.id, ["settings.view"]);
			await groups.setUserGroups(operator.id, [group.id]);
			const { cookie } = await loginAs(app, "operator", "password-2");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const nav = extractNav(await res.text());

			expect(nav).toContain('href="/admin/settings"');
			expect(nav).not.toContain('href="/admin/jobs"');
			expect(nav).not.toContain('href="/admin/audit"');
			expect(nav).not.toContain('href="/admin/resources/publishers"');
		});

		test("a superuser's dashboard nav includes every wired section", async () => {
			const { app, users } = buildApp({ withNavSections: true });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const nav = extractNav(await res.text());

			expect(nav).toContain('href="/admin/jobs"');
			expect(nav).toContain('href="/admin/settings"');
			expect(nav).toContain('href="/admin/audit"');
			expect(nav).toContain('href="/admin/resources/publishers"');
		});

		test("a non-superuser's dashboard body lists only the resource they hold view permission for", async () => {
			const { app, users } = buildApp({ withNavSections: true });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			await users.createUser({
				username: "operator",
				password: "password-2",
				permissions: ["resource.publishers.view"],
			});
			const { cookie } = await loginAs(app, "operator", "password-2");

			const res = await app.request("/admin", { headers: { Cookie: cookie } });
			const content = extractContent(await res.text());

			expect(content).toContain('href="/admin/resources/publishers"');
			expect(content).not.toContain('href="/admin/resources/books"');
		});
	});

	describe("create flow", () => {
		test("creates a user with permissions and group membership, and records an audit entry without the password", async () => {
			const { app, users, groups, audit } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const group = await groups.createGroup({ name: "Editors" });

			const res = await app.request("/admin/accounts/users", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					username: "newbie",
					password: "password-2",
					label: "Newbie",
					permissions: "jobs.view",
					groups: group.id,
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/accounts/users");

			const created = await users.findByUsername("newbie");
			if (!created) throw new Error("expected the user to have been created");
			expect(await users.userPermissions(created.id)).toEqual(["jobs.view"]);
			expect((await groups.userGroups(created.id)).map((g) => g.id)).toEqual([group.id]);

			expect(audit.recordCalls).toHaveLength(1);
			const entry = audit.recordCalls[0];
			expect(entry?.action).toBe("accounts.user.create");
			expect(JSON.stringify(entry?.changes)).not.toContain("password-2");
		});
	});

	describe("update flow", () => {
		test("preserves an unrecognized stored permission across an edit", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const target = await users.createUser({ username: "member", password: "password-2" });
			await users.setUserPermissions(target.id, ["custom.thing"]);

			const res = await app.request(`/admin/accounts/users/${target.id}`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					username: "member",
					label: "",
					permissions: "jobs.view",
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(303);
			const permissions = await users.userPermissions(target.id);
			expect(permissions).toContain("custom.thing");
			expect(permissions).toContain("jobs.view");
		});
	});

	describe("last-active-superuser protection", () => {
		test("rejects deactivating, demoting, or deleting the only active superuser", async () => {
			const { app, users } = buildApp();
			const root = await users.createUser({
				username: "root",
				password: "password-1",
				isSuperuser: true,
			});
			const { cookie, token } = await loginAs(app, "root", "password-1");

			const demoteRes = await app.request(`/admin/accounts/users/${root.id}`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "root", label: "", csrf_token: token }).toString(),
			});
			expect(demoteRes.status).toBe(422);
			expect(await users.retrieve(root.id)).toMatchObject({ isSuperuser: true, isActive: true });

			const deleteRes = await app.request(`/admin/accounts/users/${root.id}/delete`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ post: "yes", csrf_token: token }).toString(),
			});
			expect(deleteRes.status).toBe(303);
			expect(await users.retrieve(root.id)).not.toBeUndefined();
		});

		test("allows demoting a superuser when a second active superuser remains", async () => {
			const { app, users } = buildApp();
			const root = await users.createUser({
				username: "root",
				password: "password-1",
				isSuperuser: true,
			});
			await users.createUser({ username: "root2", password: "password-2", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");

			const res = await app.request(`/admin/accounts/users/${root.id}`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "root", label: "", csrf_token: token }).toString(),
			});

			expect(res.status).toBe(303);
			expect(await users.retrieve(root.id)).toMatchObject({ isSuperuser: false });
		});
	});

	describe("password change", () => {
		test("logs in with the new password after a successful change, and re-renders on a too-short password", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const target = await users.createUser({ username: "member", password: "password-2" });

			const shortRes = await app.request(`/admin/accounts/users/${target.id}/password`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password: "short", csrf_token: token }).toString(),
			});
			expect(shortRes.status).toBe(422);

			const changeRes = await app.request(`/admin/accounts/users/${target.id}/password`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ password: "brand-new-password", csrf_token: token }).toString(),
			});
			expect(changeRes.status).toBe(303);

			const authenticated = await users.authenticate({
				username: "member",
				password: "brand-new-password",
			});
			expect(authenticated).not.toBeNull();
		});
	});

	describe("delete flow", () => {
		test("removes the user and its group membership, and records an audit entry", async () => {
			const { app, users, groups, audit } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const target = await users.createUser({ username: "member", password: "password-2" });
			const group = await groups.createGroup({ name: "Editors" });
			await groups.setUserGroups(target.id, [group.id]);

			const res = await app.request(`/admin/accounts/users/${target.id}/delete`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ post: "yes", csrf_token: token }).toString(),
			});

			expect(res.status).toBe(303);
			expect(await users.retrieve(target.id)).toBeUndefined();
			expect(await groups.userGroups(target.id)).toEqual([]);
			expect(audit.recordCalls.some((entry) => entry.action === "accounts.user.delete")).toBe(true);
		});
	});

	describe("not found", () => {
		test("GET /accounts/users/:id/edit for a nonexistent id is a 404", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin/accounts/users/does-not-exist/edit", {
				headers: { Cookie: cookie },
			});

			expect(res.status).toBe(404);
		});
	});

	describe("groups management screen", () => {
		test("a superuser can open the groups list, and a non-superuser is denied", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			await users.createUser({
				username: "operator",
				password: "password-2",
				permissions: [...ADMIN_BUILTIN_PERMISSIONS],
			});

			const { cookie: rootCookie } = await loginAs(app, "root", "password-1");
			const superuserRes = await app.request("/admin/accounts/groups", {
				headers: { Cookie: rootCookie },
			});
			expect(superuserRes.status).toBe(200);

			const { cookie: operatorCookie } = await loginAs(app, "operator", "password-2");
			const operatorRes = await app.request("/admin/accounts/groups", {
				headers: { Cookie: operatorCookie },
			});
			expect(operatorRes.status).toBe(403);
		});

		test("creates a group with the checked permissions, and records an audit entry", async () => {
			const { app, users, groups, audit } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin/accounts/groups", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Editors",
					permissions: "jobs.view",
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/accounts/groups");

			const created = (await groups.listGroups()).find((group) => group.name === "Editors");
			if (!created) throw new Error("expected the group to have been created");
			expect(await groups.groupPermissions(created.id)).toEqual(["jobs.view"]);

			const entry = audit.recordCalls.find((call) => call.action === "accounts.group.create");
			expect(entry?.target).toBe(created.id);
		});

		test("preserves an unrecognized stored permission across an edit", async () => {
			const { app, users, groups } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const group = await groups.createGroup({ name: "Editors" });
			await groups.setGroupPermissions(group.id, ["custom.thing"]);

			const res = await app.request(`/admin/accounts/groups/${group.id}`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Editors renamed",
					permissions: "jobs.view",
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(303);
			const permissions = await groups.groupPermissions(group.id);
			expect(permissions).toContain("custom.thing");
			expect(permissions).toContain("jobs.view");
			const updated = (await groups.listGroups()).find((row) => row.id === group.id);
			expect(updated?.name).toBe("Editors renamed");
		});

		test("removes the group and its membership, and records an audit entry", async () => {
			const { app, users, groups, audit } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie, token } = await loginAs(app, "root", "password-1");
			const member = await users.createUser({ username: "member", password: "password-2" });
			const group = await groups.createGroup({ name: "Editors" });
			await groups.setUserGroups(member.id, [group.id]);

			const res = await app.request(`/admin/accounts/groups/${group.id}/delete`, {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ post: "yes", csrf_token: token }).toString(),
			});

			expect(res.status).toBe(303);
			expect((await groups.listGroups()).some((row) => row.id === group.id)).toBe(false);
			expect(await groups.userGroups(member.id)).toEqual([]);
			expect(audit.recordCalls.some((entry) => entry.action === "accounts.group.delete")).toBe(
				true,
			);
		});

		test("is a 404 when groups is not injected", async () => {
			const { app, users } = buildApp({ groups: false });
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin/accounts/groups", { headers: { Cookie: cookie } });

			expect(res.status).toBe(404);
		});

		test("the users list shows a link to the groups list when groups is injected", async () => {
			const { app, users } = buildApp();
			await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
			const { cookie } = await loginAs(app, "root", "password-1");

			const res = await app.request("/admin/accounts/users", { headers: { Cookie: cookie } });
			const body = await res.text();

			expect(body).toContain('href="/admin/accounts/groups"');
		});
	});

	describe("login with an explicit auth override", () => {
		/**
		 * Builds an app with `accounts` injected AND an explicit `auth` override
		 * (`effectiveAuth`'s escape hatch), whose `authenticate` returns a fixed
		 * identity for the right credentials — regardless of whether that
		 * identity's `id` actually names a row in `users`. This is the
		 * misconfiguration `POST /login` guards against: without the guard, the
		 * session would be set to an identity the accounts gate can never
		 * re-validate, redirecting back to `/login` on every subsequent request.
		 */
		const buildOverrideApp = (identityId: string) => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

			const auth: AdminPanelOptions<SessionEnv>["auth"] = {
				authenticate: async (_c, credentials): Promise<AdminIdentity | null> =>
					credentials.username === "operator" && credentials.password === "password-1"
						? { id: identityId, label: "Operator" }
						: null,
			};

			const app = new Hono<SessionEnv>();
			app.use(sessionAccessor.register);
			app.route(
				"/admin",
				new AdminPanel<SessionEnv>({
					session: sessionAccessor.use,
					csrf,
					accounts: { users },
					auth,
				}),
			);

			return { app, users };
		};

		test("valid credentials that resolve to a nonexistent accounts row re-render the login form instead of logging in", async () => {
			const { app } = buildOverrideApp("no-such-user-id");

			const { loginRes, cookie } = await loginAs(app, "operator", "password-1");
			expect(loginRes.status).toBe(401);

			/** No identity was stored: the dashboard still redirects to `/login`. */
			const res = await app.request("/admin", { headers: { Cookie: cookie }, redirect: "manual" });
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toContain("/admin/login");
		});

		test("valid credentials that resolve to an inactive accounts row re-render the login form instead of logging in", async () => {
			const seedUsers = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);
			const created = await seedUsers.createUser({
				username: "shadow",
				password: "irrelevant",
				isActive: false,
			});

			const { app } = buildOverrideApp(created.id);
			const { loginRes, cookie } = await loginAs(app, "operator", "password-1");
			expect(loginRes.status).toBe(401);

			const res = await app.request("/admin", { headers: { Cookie: cookie }, redirect: "manual" });
			expect(res.status).toBe(302);
			expect(res.headers.get("Location")).toContain("/admin/login");
		});
	});

	describe("bulk-action body dispatch permission", () => {
		/**
		 * `POST /resources/<key>` serves both the create form and the list
		 * screen's bulk-action form. An empty (or otherwise non-"delete") bulk
		 * action is a no-op redirect the route handler never guards with a
		 * permission (`handleBulkAction`), so `requiredPermission` must not
		 * demand the resource's create permission for it — only `action=delete`
		 * should require anything (the delete permission).
		 */
		const buildBulkApp = () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
			const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

			const app = new Hono<SessionEnv>();
			app.use(sessionAccessor.register);
			app.route(
				"/admin",
				new AdminPanel<SessionEnv>({
					session: sessionAccessor.use,
					csrf,
					accounts: { users },
					resources: [new WritablePublisherResource(new PublisherModel(ctx.db))],
				}),
			);

			return { app, users };
		};

		test("a non-superuser with view and delete (but not create) can submit an empty bulk action", async () => {
			const { app, users } = buildBulkApp();
			await users.createUser({
				username: "operator",
				password: "password-1",
				permissions: [
					resourcePermission("publishers", "view"),
					resourcePermission("publishers", "delete"),
				],
			});
			const { cookie, token } = await loginAs(app, "operator", "password-1");

			const res = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ action: "", csrf_token: token }).toString(),
			});

			expect(res.status).toBe(303);
		});

		test("a non-superuser with no permissions is still denied a create-form submission (no `action` field)", async () => {
			const { app, users } = buildBulkApp();
			await users.createUser({ username: "operator", password: "password-1" });
			const { cookie, token } = await loginAs(app, "operator", "password-1");

			const res = await app.request("/admin/resources/publishers", {
				method: "POST",
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					name: "Acme",
					contactEmail: "acme@example.com",
					csrf_token: token,
				}).toString(),
			});

			expect(res.status).toBe(403);
		});
	});
});

/**
 * Standalone `publishers` schema/form so this suite's bulk-action and
 * table-driven tests below can wire a writable resource (this file's other
 * `PublisherResource`/`BookResource`, used by the `describe` blocks above, have
 * no `form()` and so cannot exercise the create/edit/delete routes).
 */
type PublisherInput = { name: string; contactEmail: string; status: string };

/** Minimal Standard Schema implementation for tests (same convention as `admin_panel_accounts.test.ts`). */
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

/** Admin form for `publishers` that only requires `name` (same convention as `admin_panel_accounts.test.ts`, simplified). */
class WritablePublisherForm extends Form<StandardSchemaV1<unknown, PublisherInput>, string> {
	protected schema() {
		return defineStubSchema<PublisherInput>((value) => {
			const record = value as Record<string, unknown>;
			if (typeof record.name !== "string" || record.name === "") {
				return { issues: [{ message: "Name is required", path: ["name"] }] };
			}
			return {
				value: {
					name: record.name,
					contactEmail: (record.contactEmail as string | undefined) ?? "contact@example.com",
					status: (record.status as string | undefined) ?? "active",
				},
			};
		});
	}
	protected fields(): Record<string, FieldDef> {
		return fieldsFromTable(schema.publishers);
	}
}

/** Writable `publishers` resource (has `form()`, unlike this file's other `PublisherResource`) used only by the table-driven test below. */
class WritablePublisherResource extends AdminResource {
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
		return new WritablePublisherForm();
	}
}

/**
 * Table-driven guard against `requiredPermission` (`admin_panel.tsx`) silently
 * drifting out of sync with the routes actually wired: each row below names
 * one route + HTTP method and the exact permission it should demand.
 * Rows are checked two ways — a non-superuser holding NO permissions must be
 * denied every one of them, and a non-superuser holding ONLY the named
 * permission must pass every one of them (except `accounts`, which no granted
 * permission can satisfy: see the `SUPERUSER_ONLY` sentinel). Adding a new
 * route without updating both this table and `requiredPermission` itself is
 * exactly the drift this test exists to catch.
 */
describe("requiredPermission mapping (route-to-permission table)", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;
	let publisherId: string;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
		const [row] = await ctx.db
			.insert(schema.publishers)
			.values({
				id: "pub-fixture-1",
				name: "Acme",
				contactEmail: "acme@example.com",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
			.returning();
		if (!row) throw new Error("failed to seed the publishers fixture row");
		publisherId = row.id;
	});

	afterEach(() => {
		ctx.client.close();
	});

	const buildApp = () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
		const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);
		const audit = buildFakeAuditLog();
		const jobsConsole = buildFakeJobsConsole();

		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				session: sessionAccessor.use,
				csrf,
				accounts: { users },
				jobs: { console: jobsConsole },
				settings: buildFakeSettings(),
				audit: { log: audit },
				resources: [new WritablePublisherResource(new PublisherModel(ctx.db))],
			}),
		);

		return { app, users };
	};

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
		return { cookie, token };
	};

	/** One row per route this suite covers, keyed by a unique username for its "granted" case. */
	const table: {
		name: string;
		method: "GET" | "POST";
		path: () => string;
		permission: string | null;
		body?: Record<string, string>;
	}[] = [
		{ name: "GET /jobs", method: "GET", path: () => "/admin/jobs", permission: "jobs.view" },
		{
			name: "POST /jobs/:id/retry",
			method: "POST",
			path: () => "/admin/jobs/job-1/retry",
			permission: "jobs.manage",
		},
		{
			name: "POST /jobs/:id/delete",
			method: "POST",
			path: () => "/admin/jobs/job-1/delete",
			permission: "jobs.manage",
		},
		{
			name: "GET /settings",
			method: "GET",
			path: () => "/admin/settings",
			permission: "settings.view",
		},
		{
			name: "POST /settings/flags/:name",
			method: "POST",
			path: () => "/admin/settings/flags/beta",
			permission: "settings.manage",
			body: { op: "enable" },
		},
		{
			name: "POST /settings/maintenance",
			method: "POST",
			path: () => "/admin/settings/maintenance",
			permission: "settings.manage",
			body: { op: "enable" },
		},
		{ name: "GET /audit", method: "GET", path: () => "/admin/audit", permission: "audit.view" },
		{
			name: "GET /resources/publishers (list)",
			method: "GET",
			path: () => "/admin/resources/publishers",
			permission: resourcePermission("publishers", "view"),
		},
		{
			name: "GET /resources/publishers/new",
			method: "GET",
			path: () => "/admin/resources/publishers/new",
			permission: resourcePermission("publishers", "create"),
		},
		{
			name: "GET /resources/publishers/:id (show)",
			method: "GET",
			path: () => `/admin/resources/publishers/${publisherId}`,
			permission: resourcePermission("publishers", "view"),
		},
		{
			name: "GET /resources/publishers/:id/edit",
			method: "GET",
			path: () => `/admin/resources/publishers/${publisherId}/edit`,
			permission: resourcePermission("publishers", "update"),
		},
		{
			name: "GET /resources/publishers/:id/delete",
			method: "GET",
			path: () => `/admin/resources/publishers/${publisherId}/delete`,
			permission: resourcePermission("publishers", "delete"),
		},
		{
			name: "POST /resources/publishers (create)",
			method: "POST",
			path: () => "/admin/resources/publishers",
			permission: resourcePermission("publishers", "create"),
			body: { name: "New Co", contactEmail: "new@example.com" },
		},
		{
			name: "POST /resources/publishers/:id (update)",
			method: "POST",
			path: () => `/admin/resources/publishers/${publisherId}`,
			permission: resourcePermission("publishers", "update"),
			body: { name: "Acme Updated", contactEmail: "acme@example.com" },
		},
		{
			name: "POST /resources/publishers/:id/delete",
			method: "POST",
			path: () => `/admin/resources/publishers/${publisherId}/delete`,
			permission: resourcePermission("publishers", "delete"),
			body: { post: "yes" },
		},
	];

	test("a non-superuser holding no permissions is denied every mapped route", async () => {
		const { app, users } = buildApp();
		await users.createUser({ username: "denied", password: "password-1" });
		const { cookie, token } = await loginAs(app, "denied", "password-1");

		for (const row of table) {
			const res = await app.request(row.path(), {
				method: row.method,
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body:
					row.method === "POST"
						? new URLSearchParams({ ...row.body, csrf_token: token }).toString()
						: undefined,
			});
			expect(res.status, row.name).toBe(403);
		}
	});

	test("a non-superuser holding exactly the mapped permission is not denied", async () => {
		const { app, users } = buildApp();

		for (const [index, row] of table.entries()) {
			if (!row.permission) continue;
			const username = `granted-${index}`;
			await users.createUser({ username, password: "password-1", permissions: [row.permission] });
			const { cookie, token } = await loginAs(app, username, "password-1");

			const res = await app.request(row.path(), {
				method: row.method,
				headers: { Cookie: cookie, "content-type": "application/x-www-form-urlencoded" },
				body:
					row.method === "POST"
						? new URLSearchParams({ ...row.body, csrf_token: token }).toString()
						: undefined,
			});
			expect(res.status, row.name).not.toBe(403);
		}
	});

	test("a non-superuser is denied `/accounts/*` regardless of which permission they hold", async () => {
		const { app, users } = buildApp();
		await users.createUser({
			username: "operator",
			password: "password-1",
			permissions: [
				...ADMIN_BUILTIN_PERMISSIONS,
				...table.map((row) => row.permission).filter((p): p is string => p !== null),
			],
		});
		const { cookie } = await loginAs(app, "operator", "password-1");

		const res = await app.request("/admin/accounts/users", { headers: { Cookie: cookie } });

		expect(res.status).toBe(403);
	});
});

/**
 * Guards the fix for the resource list/show screens rendering Add/Edit/Delete
 * links unconditionally from `AdminResource#canWrite()`, regardless of the
 * current operator's granted permission set — an operator holding only
 * `resource.<key>.view` would see links that 403 the moment they are clicked.
 * `AdminPanel` now additionally checks `resource.<key>.create`/`update`/`delete`
 * against `permissionFilter` before showing each action, same as `buildNav`.
 */
describe("resource list/show screens hide action links the operator cannot use", () => {
	let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;
	let publisherId: string;

	beforeEach(async () => {
		ctx = await createTestDb({ schema, migrationsFolder });
		const [row] = await ctx.db
			.insert(schema.publishers)
			.values({
				id: "pub-fixture-1",
				name: "Acme",
				contactEmail: "acme@example.com",
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			})
			.returning();
		if (!row) throw new Error("failed to seed the publishers fixture row");
		publisherId = row.id;
	});

	afterEach(() => {
		ctx.client.close();
	});

	/** Builds an app with `accounts` injected (permission filtering active). */
	const buildAccountsApp = () => {
		const storage = new InMemorySessionStorage();
		const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
		const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
		const users = new SQLiteAdminAccounts(ctx.db, schema.adminUsers);

		const app = new Hono<SessionEnv>();
		app.use(sessionAccessor.register);
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				session: sessionAccessor.use,
				csrf,
				accounts: { users },
				resources: [new WritablePublisherResource(new PublisherModel(ctx.db))],
			}),
		);

		return { app, users };
	};

	/** Builds an app with only `authorize` (no `accounts`) — the back-compat case where `canWrite()` alone decides. */
	const buildAuthorizeOnlyApp = () => {
		const app = new Hono<SessionEnv>();
		app.route(
			"/admin",
			new AdminPanel<SessionEnv>({
				authorize: () => true,
				resources: [new WritablePublisherResource(new PublisherModel(ctx.db))],
			}),
		);
		return app;
	};

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
		return { cookie };
	};

	const addLinkHref = `href="/admin/resources/publishers/new"`;
	const editLinkHref = () => `href="/admin/resources/publishers/${publisherId}/edit"`;
	const deleteLinkHref = () => `href="/admin/resources/publishers/${publisherId}/delete"`;

	test("view-only permission: list screen has neither the Add link nor the bulk-action UI nor a row Edit/Delete link", async () => {
		const { app, users } = buildAccountsApp();
		await users.createUser({
			username: "viewer",
			password: "password-1",
			permissions: [resourcePermission("publishers", "view")],
		});
		const { cookie } = await loginAs(app, "viewer", "password-1");

		const res = await app.request("/admin/resources/publishers", { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).not.toContain(addLinkHref);
		expect(html).not.toContain('id="changelist-form"');
		expect(html).not.toContain('name="_selected_action"');
		expect(html).not.toContain(editLinkHref());
		expect(html).not.toContain(deleteLinkHref());
		/** The read-only detail link is still there — view access itself is unaffected. */
		expect(html).toContain(`href="/admin/resources/publishers/${publisherId}"`);
	});

	test("view-only permission: show screen has neither the Edit link nor the Delete link", async () => {
		const { app, users } = buildAccountsApp();
		await users.createUser({
			username: "viewer",
			password: "password-1",
			permissions: [resourcePermission("publishers", "view")],
		});
		const { cookie } = await loginAs(app, "viewer", "password-1");

		const res = await app.request(`/admin/resources/publishers/${publisherId}`, {
			headers: { Cookie: cookie },
		});
		expect(res.status).toBe(200);
		const html = await res.text();

		expect(html).not.toContain(editLinkHref());
		expect(html).not.toContain(deleteLinkHref());
	});

	test("view+update permission: the Edit link appears but the Add link and Delete link do not", async () => {
		const { app, users } = buildAccountsApp();
		await users.createUser({
			username: "editor",
			password: "password-1",
			permissions: [
				resourcePermission("publishers", "view"),
				resourcePermission("publishers", "update"),
			],
		});
		const { cookie } = await loginAs(app, "editor", "password-1");

		const listRes = await app.request("/admin/resources/publishers", {
			headers: { Cookie: cookie },
		});
		const listHtml = await listRes.text();
		expect(listHtml).toContain(editLinkHref());
		expect(listHtml).not.toContain(addLinkHref);
		expect(listHtml).not.toContain(deleteLinkHref());
		expect(listHtml).not.toContain('id="changelist-form"');

		const showRes = await app.request(`/admin/resources/publishers/${publisherId}`, {
			headers: { Cookie: cookie },
		});
		const showHtml = await showRes.text();
		expect(showHtml).toContain(editLinkHref());
		expect(showHtml).not.toContain(deleteLinkHref());
	});

	test("superuser: every action link and the bulk-action UI are shown, same as before this fix", async () => {
		const { app, users } = buildAccountsApp();
		await users.createUser({ username: "root", password: "password-1", isSuperuser: true });
		const { cookie } = await loginAs(app, "root", "password-1");

		const listRes = await app.request("/admin/resources/publishers", {
			headers: { Cookie: cookie },
		});
		const listHtml = await listRes.text();
		expect(listHtml).toContain(addLinkHref);
		expect(listHtml).toContain(editLinkHref());
		expect(listHtml).toContain(deleteLinkHref());
		expect(listHtml).toContain('id="changelist-form"');

		const showRes = await app.request(`/admin/resources/publishers/${publisherId}`, {
			headers: { Cookie: cookie },
		});
		const showHtml = await showRes.text();
		expect(showHtml).toContain(editLinkHref());
		expect(showHtml).toContain(deleteLinkHref());
	});

	test("no accounts injected (authorize-only): every action link is shown, matching AdminResource#canWrite() alone", async () => {
		const app = buildAuthorizeOnlyApp();

		const listRes = await app.request("/admin/resources/publishers");
		const listHtml = await listRes.text();
		expect(listHtml).toContain(addLinkHref);
		expect(listHtml).toContain(editLinkHref());
		expect(listHtml).toContain(deleteLinkHref());
		expect(listHtml).toContain('id="changelist-form"');

		const showRes = await app.request(`/admin/resources/publishers/${publisherId}`);
		const showHtml = await showRes.text();
		expect(showHtml).toContain(editLinkHref());
		expect(showHtml).toContain(deleteLinkHref());
	});
});
