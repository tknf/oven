/**
 * Tests for `AdminPanel`. Covers the skeleton (mount base + authorization + dashboard)
 * as well as the job console / settings / audit log screen wiring (#7). Follows the
 * `RouteHandler` testing convention (`app.route()` + `app.request()`), matching
 * `test/mailer/mail_preview_handler.test.ts`.
 *
 * Since the job console / settings / audit log dependencies are all received through
 * structural interfaces (`admin_types.ts`), tests inject plain object fakes directly
 * instead of assembling drizzle/KV.
 */
import type { Env } from "hono";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { AdminPanel } from "../../src/admin/admin_panel.js";
import type { AdminAuditRow, AdminJobRow } from "../../src/admin/admin_types.js";
import { SQLiteAuditLog } from "../../src/audit/sqlite_audit_log.js";
import { SQLiteJobsConsole } from "../../src/jobs/sqlite_jobs_console.js";
import { InMemoryKeyValueStore } from "../../src/kv/in_memory_key_value_store.js";
import { FeatureFlags } from "../../src/kv/feature_flags.js";
import { Csrf } from "../../src/security/csrf.js";
import { MaintenanceMode } from "../../src/security/maintenance_mode.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { createTestDb } from "../../src/test/db.js";
import * as schema from "../test_support/fixtures/schema.js";

type SessionEnv = Env & { Variables: { session: Session } };

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

/** Builds an `AdminPanel` test app wired with session + CSRF + jobs section. */
const buildCsrfWiredApp = () => {
	const storage = new InMemorySessionStorage();
	const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
	const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });
	const console_ = buildFakeJobsConsole();

	const app = new Hono<SessionEnv>();
	app.use(sessionAccessor.register);
	app.route(
		"/admin",
		new AdminPanel<SessionEnv>({ authorize: () => true, csrf, jobs: { console: console_ } }),
	);

	return { app, console_ };
};

/**
 * Builds an `AdminPanel` test app wired with session + `auth` (fixed `admin`/`secret`
 * credentials), and optionally `csrf` (`overrides.csrf`).
 */
const buildAuthWiredApp = (overrides: { csrf?: boolean } = {}) => {
	const storage = new InMemorySessionStorage();
	const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
	const csrf = overrides.csrf ? new Csrf<SessionEnv>({ session: sessionAccessor.use }) : undefined;

	const app = new Hono<SessionEnv>();
	app.use(sessionAccessor.register);
	app.route(
		"/admin",
		new AdminPanel<SessionEnv>({
			authorize: () => true,
			session: sessionAccessor.use,
			csrf,
			auth: {
				authenticate: async (_c, { username, password }) =>
					username === "admin" && password === "secret" ? { id: "admin", label: "Admin" } : null,
			},
		}),
	);

	return { app };
};

const migrationsFolder = new URL("../test_support/fixtures/migrations", import.meta.url).pathname;

/** Test data factory for `AdminJobRow`. */
const buildJobRow = (overrides: Partial<AdminJobRow> = {}): AdminJobRow => ({
	id: "job-1",
	name: "SendWelcomeEmail",
	priority: 0,
	runAt: 1700000000000,
	attempts: 0,
	failedAt: null,
	lastError: null,
	...overrides,
});

/** Test data factory for `AdminAuditRow`. */
const buildAuditRow = (overrides: Partial<AdminAuditRow> = {}): AdminAuditRow => ({
	id: "audit-1",
	actor: "admin-1",
	action: "job.retry",
	target: "job-1",
	changes: null,
	createdAt: 1700000000000,
	...overrides,
});

/** Fake `AdminJobsConsole` used in tests. Records the arguments it was called with. */
const buildFakeJobsConsole = (
	overrides: { pending?: AdminJobRow[]; failed?: AdminJobRow[] } = {},
) => {
	const pending = overrides.pending ?? [buildJobRow()];
	const failed = overrides.failed ?? [
		buildJobRow({ id: "job-2", failedAt: 1700000001000, lastError: "boom" }),
	];
	const retryFailedCalls: string[] = [];
	const deleteJobCalls: string[] = [];
	return {
		retryFailedCalls,
		deleteJobCalls,
		listPending: async () => pending,
		listFailed: async () => failed,
		retryFailed: async (id: string) => {
			retryFailedCalls.push(id);
			return true;
		},
		deleteJob: async (id: string) => {
			deleteJobCalls.push(id);
			return true;
		},
	};
};

/** Fake `AdminFeatureFlags` used in tests. Keeps internal state in a Map. */
const buildFakeFeatureFlags = (initial: Record<string, boolean> = {}) => {
	const state = new Map(Object.entries(initial));
	return {
		state,
		enabled: async (name: string) => state.get(name) ?? false,
		enable: async (name: string) => {
			state.set(name, true);
		},
		disable: async (name: string) => {
			state.set(name, false);
		},
	};
};

/** Fake `AdminMaintenanceMode` used in tests. */
const buildFakeMaintenanceMode = (initial = false) => {
	let enabled = initial;
	return {
		enabled: async () => enabled,
		enable: async () => {
			enabled = true;
		},
		disable: async () => {
			enabled = false;
		},
	};
};

/** Fake `AdminAuditLog` used in tests. Records the options passed to `list` and the calls to `record`. */
const buildFakeAuditLog = (rows: AdminAuditRow[] = [buildAuditRow()]) => {
	const listCalls: { actor?: string; action?: string; target?: string }[] = [];
	const recordCalls: { actor: string; action: string; target: string; changes?: unknown }[] = [];
	return {
		listCalls,
		recordCalls,
		list: async (options: { actor?: string; action?: string; target?: string } = {}) => {
			listCalls.push(options);
			return rows;
		},
		record: async (entry: { actor: string; action: string; target: string; changes?: unknown }) => {
			recordCalls.push(entry);
		},
	};
};

describe("AdminPanel", () => {
	test("returns 403 when authorize returns false", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => false }));

		const res = await app.request("/admin");

		expect(res.status).toBe(403);
	});

	test("returns 403 when authorize returns false asynchronously", async () => {
		const app = new Hono();
		app.route(
			"/admin",
			new AdminPanel({
				authorize: async () => {
					await Promise.resolve();
					return false;
				},
			}),
		);

		const res = await app.request("/admin");

		expect(res.status).toBe(403);
	});

	test("renders the dashboard with 200 when authorize returns true (default brand)", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("Admin");
	});

	test("reflects the brand option in the dashboard when specified", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true, brand: "My Admin" }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(res.status).toBe(200);
		expect(body).toContain("My Admin");
	});

	test("nav Dashboard link points at the mounted route without a trailing slash", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(body).toContain('href="/admin"');
		expect(body).not.toContain('href="/admin/"');

		const dashboardRes = await app.request("/admin");
		expect(dashboardRes.status).toBe(200);
	});

	test("overrides the authorization-failure status when denyStatus is specified", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => false, denyStatus: 401 }));

		const res = await app.request("/admin");

		expect(res.status).toBe(401);
	});

	test("authorized dashboard HTML includes inline styles from admin.css", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(body).toContain("<style>");
		expect(body).toContain("#nav-sidebar ul");
	});

	test("inline styles keep raw double quotes instead of being HTML-escaped", async () => {
		const app = new Hono();
		app.route("/admin", new AdminPanel({ authorize: () => true }));

		const res = await app.request("/admin");
		const body = await res.text();

		expect(body).toContain('nav[aria-label="pagination"]');
		expect(body).not.toContain("aria-label=&quot;pagination&quot;");
		expect(body).toContain('html[data-theme="dark"]');
		expect(body).not.toContain("data-theme=&quot;dark&quot;");
	});

	describe("job console", () => {
		test("GET /admin/jobs returns 404 when not injected (route does not exist)", async () => {
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true }));

			const res = await app.request("/admin/jobs");

			expect(res.status).toBe(404);
		});

		test("GET /admin/jobs returns 200 with pending/failed content when injected", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("SendWelcomeEmail");
			expect(body).toContain("boom");
		});

		test("POST /admin/jobs/:id/retry calls retryFailed and redirects to /admin/jobs with 303", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs/job-2/retry", { method: "POST" });

			expect(console_.retryFailedCalls).toEqual(["job-2"]);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/jobs");
		});

		test("POST /admin/jobs/:id/delete calls deleteJob and redirects to /admin/jobs with 303", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs/job-1/delete", { method: "POST" });

			expect(console_.deleteJobCalls).toEqual(["job-1"]);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/jobs");
		});

		test("authorize also applies to the jobs routes", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => false, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs");

			expect(res.status).toBe(403);
		});
	});

	describe("settings", () => {
		test("GET /admin/settings includes flag names and state when flags are injected", async () => {
			const app = new Hono();
			const flags = buildFakeFeatureFlags({ beta: true });
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					settings: { featureFlags: { flags, names: ["beta"] } },
				}),
			);

			const res = await app.request("/admin/settings");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("beta");
			expect(body).toContain("Enabled");
		});

		test("POST /admin/settings/flags/:name calls flags.enable and redirects back to /admin/settings with 303", async () => {
			const app = new Hono();
			const flags = buildFakeFeatureFlags({ beta: false });
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					settings: { featureFlags: { flags, names: ["beta"] } },
				}),
			);

			const res = await app.request("/admin/settings/flags/beta", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ op: "enable" }).toString(),
			});

			expect(flags.state.get("beta")).toBe(true);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/settings");
		});

		test("toggling maintenance mode redirects with 303 when injected", async () => {
			const app = new Hono();
			const maintenance = buildFakeMaintenanceMode(false);
			app.route("/admin", new AdminPanel({ authorize: () => true, settings: { maintenance } }));

			const res = await app.request("/admin/settings/maintenance", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ op: "enable" }).toString(),
			});

			expect(await maintenance.enabled()).toBe(true);
			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/settings");
		});
	});

	describe("audit log", () => {
		test("GET /admin/audit includes the list result when injected", async () => {
			const app = new Hono();
			const auditLog = buildFakeAuditLog([buildAuditRow({ actor: "actor-xyz" })]);
			app.route("/admin", new AdminPanel({ authorize: () => true, audit: { log: auditLog } }));

			const res = await app.request("/admin/audit");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("actor-xyz");
		});

		test("query filters are passed through to list", async () => {
			const app = new Hono();
			const auditLog = buildFakeAuditLog();
			app.route("/admin", new AdminPanel({ authorize: () => true, audit: { log: auditLog } }));

			await app.request("/admin/audit?actor=admin-1&action=job.retry");

			expect(auditLog.listCalls).toEqual([
				{ actor: "admin-1", action: "job.retry", target: undefined },
			]);
		});
	});

	describe("audit recording", () => {
		test("POST /admin/jobs/:id/retry calls audit.log.record when jobs+audit are injected", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			const auditLog = buildFakeAuditLog();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					jobs: { console: console_ },
					audit: { log: auditLog },
				}),
			);

			await app.request("/admin/jobs/job-2/retry", { method: "POST" });

			expect(auditLog.recordCalls).toEqual([
				{ actor: "admin", action: "job.retry", target: "job-2", changes: { ok: true } },
			]);
		});

		test("record is not called when audit is not injected (no side effect to verify since nothing was injected)", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs/job-2/retry", { method: "POST" });

			expect(res.status).toBe(303);
		});
	});

	describe("CSRF", () => {
		test("POST goes through as before when csrf is not injected (backward compatibility)", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs/job-2/retry", { method: "POST" });

			expect(res.status).toBe(303);
		});

		test("console.warn is called exactly once on the first unsafe-method request when csrf is not injected", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			await app.request("/admin/jobs");
			expect(warnSpy).not.toHaveBeenCalled();

			await app.request("/admin/jobs/job-2/retry", { method: "POST" });
			await app.request("/admin/jobs/job-1/delete", { method: "POST" });

			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0]?.[0]).toContain("csrf");

			warnSpy.mockRestore();
		});

		test("GET /admin/jobs form includes the csrf_token hidden input when csrf is injected", async () => {
			const { app } = buildCsrfWiredApp();

			const res = await app.request("/admin/jobs");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(() => extractCsrfToken(body)).not.toThrow();
		});

		test("POST without a token returns 403 when csrf is injected", async () => {
			const { app } = buildCsrfWiredApp();

			const res = await app.request("/admin/jobs/job-2/retry", { method: "POST" });

			expect(res.status).toBe(403);
		});

		test("POST with a valid token goes through when csrf is injected", async () => {
			const { app, console_ } = buildCsrfWiredApp();

			const getRes = await app.request("/admin/jobs");
			const setCookie = getRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");
			const token = extractCsrfToken(await getRes.text());

			const res = await app.request("/admin/jobs/job-2/retry", {
				method: "POST",
				headers: {
					Cookie: toCookieHeader(setCookie),
					"content-type": "application/x-www-form-urlencoded",
				},
				body: new URLSearchParams({ csrf_token: token }).toString(),
			});

			expect(res.status).toBe(303);
			expect(console_.retryFailedCalls).toEqual(["job-2"]);
		});
	});

	describe("navigation", () => {
		test("shows links for injected sections and hides non-injected sections", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).toContain("/admin/jobs");
			expect(body).not.toContain("/admin/settings");
			expect(body).not.toContain("/admin/audit");
		});
	});

	describe("user tools", () => {
		test("renders nothing when userTools is not injected (backward compatibility)", async () => {
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true }));

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).not.toContain('id="user-tools"');
		});

		test("renders the greeting and links when userTools is injected", async () => {
			const app = new Hono();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					userTools: () => ({
						greeting: "Welcome, admin.",
						links: [
							{ label: "View site", href: "/" },
							{ label: "Log out", href: "/logout", method: "post" },
						],
					}),
				}),
			);

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).toContain('id="user-tools"');
			expect(body).toContain("Welcome, admin.");
			expect(body).toContain('<a href="/">View site</a>');
			expect(body).toContain('<form method="post" action="/logout">');
			expect(body).toContain('<button type="submit">Log out</button>');
		});

		test("a get link renders as a plain anchor, not a form", async () => {
			const app = new Hono();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					userTools: () => ({ links: [{ label: "View site", href: "/" }] }),
				}),
			);

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).toContain('<a href="/">View site</a>');
			expect(body).not.toContain("<form");
		});

		test("embeds a CSRF hidden input in a post link's form when csrf is injected", async () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<SessionEnv, "session">("session", storage);
			const csrf = new Csrf<SessionEnv>({ session: sessionAccessor.use });

			const app = new Hono<SessionEnv>();
			app.use(sessionAccessor.register);
			app.route(
				"/admin",
				new AdminPanel<SessionEnv>({
					authorize: () => true,
					csrf,
					userTools: () => ({ links: [{ label: "Log out", href: "/logout", method: "post" }] }),
				}),
			);

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).toContain('<form method="post" action="/logout">');
			expect(() => extractCsrfToken(body)).not.toThrow();
		});

		test("a post link's form has no hidden input when csrf is not injected", async () => {
			const app = new Hono();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					userTools: () => ({ links: [{ label: "Log out", href: "/logout", method: "post" }] }),
				}),
			);

			const res = await app.request("/admin");
			const body = await res.text();

			expect(body).toContain('<form method="post" action="/logout">');
			expect(body).not.toContain("csrf_token");
		});
	});

	describe("i18n", () => {
		test("renders in the default English when no language is detected", async () => {
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true }));

			const res = await app.request("/admin");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("Dashboard");
		});

		test("renders in Japanese when language=ja", async () => {
			const app = new Hono();
			app.use(async (c, next) => {
				c.set("language", "ja");
				await next();
			});
			app.route("/admin", new AdminPanel({ authorize: () => true }));

			const res = await app.request("/admin");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("ダッシュボード");
		});

		test("falls back to the default English for an unsupported language", async () => {
			const app = new Hono();
			app.use(async (c, next) => {
				c.set("language", "xx");
				await next();
			});
			app.route("/admin", new AdminPanel({ authorize: () => true }));

			const res = await app.request("/admin");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("Dashboard");
		});
	});

	describe("basePath", () => {
		test("defaults to /admin but reflects into links/redirects when explicitly specified", async () => {
			const app = new Hono();
			const console_ = buildFakeJobsConsole();
			app.route(
				"/mounted",
				new AdminPanel({
					authorize: () => true,
					basePath: "/mounted",
					jobs: { console: console_ },
				}),
			);

			const dashboardRes = await app.request("/mounted");
			const dashboardBody = await dashboardRes.text();
			expect(dashboardBody).toContain("/mounted/jobs");

			const retryRes = await app.request("/mounted/jobs/job-2/retry", { method: "POST" });
			expect(retryRes.headers.get("location")).toBe("/mounted/jobs");
		});

		test("nav Dashboard link reflects a custom basePath without a trailing slash and is reachable", async () => {
			const app = new Hono();
			app.route("/dashboard", new AdminPanel({ authorize: () => true, basePath: "/dashboard" }));

			const res = await app.request("/dashboard");
			const body = await res.text();

			expect(body).toContain('href="/dashboard"');
			expect(body).not.toContain('href="/dashboard/"');
			expect(res.status).toBe(200);
		});
	});

	describe("auth", () => {
		test("throws at construction when auth is injected without session", () => {
			expect(
				() =>
					new AdminPanel({
						authorize: () => true,
						auth: { authenticate: async () => null },
					}),
			).toThrow(/session/);
		});

		test("redirects an unauthenticated request to /admin/login with next set to the original path", async () => {
			const { app } = buildAuthWiredApp();

			const res = await app.request("/admin");

			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("GET /admin/login renders the login form with 200", async () => {
			const { app } = buildAuthWiredApp();

			const res = await app.request("/admin/login");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain('action="/admin/login"');
			expect(body).toContain('name="username"');
			expect(body).toContain('name="password"');
		});

		test("POST /admin/login with valid credentials redirects to admin and the issued session then authenticates further requests", async () => {
			const { app } = buildAuthWiredApp();

			const loginRes = await app.request("/admin/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "admin", password: "secret" }).toString(),
			});
			expect(loginRes.status).toBe(303);
			expect(loginRes.headers.get("location")).toBe("/admin");

			const setCookie = loginRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");

			const dashboardRes = await app.request("/admin", {
				headers: { Cookie: toCookieHeader(setCookie) },
			});
			expect(dashboardRes.status).toBe(200);
		});

		test("POST /admin/login with invalid credentials re-renders the form with 401 and leaves the request logged out", async () => {
			const { app } = buildAuthWiredApp();

			const res = await app.request("/admin/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "admin", password: "wrong" }).toString(),
			});
			const body = await res.text();

			expect(res.status).toBe(401);
			expect(body).toContain("Please enter a correct username and password.");

			const setCookie = res.headers.get("Set-Cookie");
			const dashboardRes = await app.request("/admin", {
				headers: setCookie ? { Cookie: toCookieHeader(setCookie) } : {},
			});
			expect(dashboardRes.status).toBe(302);
		});

		test("POST /admin/logout clears the session, and the same session is redirected to login again afterward", async () => {
			const { app } = buildAuthWiredApp();

			const loginRes = await app.request("/admin/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "admin", password: "secret" }).toString(),
			});
			const setCookie = loginRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");
			const cookieHeader = toCookieHeader(setCookie);

			const logoutRes = await app.request("/admin/logout", {
				method: "POST",
				headers: { Cookie: cookieHeader },
			});
			expect(logoutRes.status).toBe(303);
			expect(logoutRes.headers.get("location")).toBe("/admin/login");

			const dashboardRes = await app.request("/admin", { headers: { Cookie: cookieHeader } });
			expect(dashboardRes.status).toBe(302);
			expect(dashboardRes.headers.get("location")).toBe("/admin/login?next=%2Fadmin");
		});

		test("when auth is not injected, there are no login/logout routes and authorize alone gates access (backward compatibility)", async () => {
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => false }));

			const loginRes = await app.request("/admin/login");
			expect(loginRes.status).toBe(404);

			const dashboardRes = await app.request("/admin");
			expect(dashboardRes.status).toBe(403);
		});

		test("the default userTools shows the identity greeting and a working logout link once logged in", async () => {
			const { app } = buildAuthWiredApp();

			const loginRes = await app.request("/admin/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "admin", password: "secret" }).toString(),
			});
			const setCookie = loginRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");

			const dashboardRes = await app.request("/admin", {
				headers: { Cookie: toCookieHeader(setCookie) },
			});
			const body = await dashboardRes.text();

			expect(body).toContain("Admin");
			expect(body).toContain('action="/admin/logout"');
			expect(body).toContain("Log out");
		});

		test("an unrecognized next target falls back to basePath instead of the raw external URL (open-redirect guard)", async () => {
			const { app } = buildAuthWiredApp();

			const res = await app.request("/admin/login?next=https%3A%2F%2Fevil.example%2F");
			const body = await res.text();

			expect(body).toContain('value="/admin"');
			expect(body).not.toContain("evil.example");
		});

		test("GET /admin/login embeds the CSRF hidden input when csrf is injected", async () => {
			const { app } = buildAuthWiredApp({ csrf: true });

			const res = await app.request("/admin/login");
			const body = await res.text();

			expect(() => extractCsrfToken(body)).not.toThrow();
		});

		test("POST /admin/login without a token returns 403 when csrf is injected", async () => {
			const { app } = buildAuthWiredApp({ csrf: true });

			const res = await app.request("/admin/login", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ username: "admin", password: "secret" }).toString(),
			});

			expect(res.status).toBe(403);
		});
	});

	/**
	 * Regression test for a type gap that fakes alone could not detect (a mismatch between
	 * the `list`-family return types in `admin_types.ts` and the real classes' looser return
	 * types). Injects the real `SQLiteJobsConsole` / `SQLiteAuditLog` / `FeatureFlags` /
	 * `MaintenanceMode` into `AdminPanel`; this wiring compiling without a type error is
	 * itself proof of assignability. Also verifies the actual behavior against a real
	 * DB/real KV.
	 */
	describe("real class injection (integration)", () => {
		let ctx: Awaited<ReturnType<typeof createTestDb<typeof schema>>>;

		/** Inserts one row into the `jobs` table and returns its id (same approach as `test/jobs/sqlite_jobs_console.test.ts`). */
		const insertJob = async (
			overrides: Partial<typeof schema.jobs.$inferInsert> &
				Pick<typeof schema.jobs.$inferInsert, "id" | "name" | "payload">,
		): Promise<string> => {
			const now = Date.now();
			await ctx.db.insert(schema.jobs).values({
				id: overrides.id,
				name: overrides.name,
				payload: overrides.payload,
				runAt: overrides.runAt ?? now,
				priority: overrides.priority ?? 0,
				attempts: overrides.attempts ?? 0,
				lockedAt: overrides.lockedAt ?? null,
				failedAt: overrides.failedAt ?? null,
				lastError: overrides.lastError ?? null,
				createdAt: overrides.createdAt ?? now,
			});
			return overrides.id;
		};

		beforeEach(async () => {
			ctx = await createTestDb({ schema, migrationsFolder });
		});

		afterEach(() => {
			ctx.client.close();
		});

		test("GET /admin/jobs returns 200 with pending/failed row content when the real SQLiteJobsConsole is injected", async () => {
			await insertJob({ id: "job-real-1", name: "SendWelcomeEmail", payload: "{}" });
			await insertJob({
				id: "job-real-2",
				name: "SendReminder",
				payload: "{}",
				failedAt: Date.now(),
				lastError: "boom",
			});

			const console_ = new SQLiteJobsConsole(ctx.db, schema.jobs);
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("SendWelcomeEmail");
			expect(body).toContain("SendReminder");
			expect(body).toContain("boom");
		});

		test("POST /admin/jobs/:id/retry actually resets failedAt to null with the real SQLiteJobsConsole injected", async () => {
			await insertJob({
				id: "job-real-3",
				name: "SendReminder",
				payload: "{}",
				failedAt: Date.now(),
				lastError: "boom",
			});

			const console_ = new SQLiteJobsConsole(ctx.db, schema.jobs);
			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true, jobs: { console: console_ } }));

			const res = await app.request("/admin/jobs/job-real-3/retry", { method: "POST" });

			expect(res.status).toBe(303);
			expect(res.headers.get("location")).toBe("/admin/jobs");
			const [row] = await ctx.db.select().from(schema.jobs).where(eq(schema.jobs.id, "job-real-3"));
			expect(row?.failedAt).toBeNull();
		});

		test("retry record is persisted as action=job.retry in the DB with the real SQLiteAuditLog injected", async () => {
			await insertJob({
				id: "job-real-4",
				name: "SendReminder",
				payload: "{}",
				failedAt: Date.now(),
				lastError: "boom",
			});

			const console_ = new SQLiteJobsConsole(ctx.db, schema.jobs);
			const log = new SQLiteAuditLog(ctx.db, schema.audits);
			const app = new Hono();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					jobs: { console: console_ },
					audit: { log },
				}),
			);

			await app.request("/admin/jobs/job-real-4/retry", { method: "POST" });

			const rows = await log.list({ action: "job.retry" });
			expect(rows).toHaveLength(1);
			expect(rows[0]?.target).toBe("job-real-4");
		});

		test("toggle operations propagate to the real KV with the real FeatureFlags/MaintenanceMode injected", async () => {
			const flags = new FeatureFlags(new InMemoryKeyValueStore());
			const maintenance = new MaintenanceMode(new InMemoryKeyValueStore());
			const app = new Hono();
			app.route(
				"/admin",
				new AdminPanel({
					authorize: () => true,
					settings: { featureFlags: { flags, names: ["beta"] }, maintenance },
				}),
			);

			const flagRes = await app.request("/admin/settings/flags/beta", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ op: "enable" }).toString(),
			});
			const maintenanceRes = await app.request("/admin/settings/maintenance", {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ op: "enable" }).toString(),
			});

			expect(flagRes.status).toBe(303);
			expect(maintenanceRes.status).toBe(303);
			await expect(flags.enabled("beta")).resolves.toBe(true);
			await expect(maintenance.enabled()).resolves.toBe(true);
		});

		test("GET /admin/audit actor filter is passed to the real list and includes only matching rows with the real SQLiteAuditLog injected", async () => {
			const log = new SQLiteAuditLog(ctx.db, schema.audits);
			await log.record({ actor: "actor-a", action: "user.update", target: "user-1" });
			await log.record({ actor: "actor-b", action: "user.delete", target: "user-2" });

			const app = new Hono();
			app.route("/admin", new AdminPanel({ authorize: () => true, audit: { log } }));

			const res = await app.request("/admin/audit?actor=actor-a");
			const body = await res.text();

			expect(res.status).toBe(200);
			expect(body).toContain("actor-a");
			expect(body).not.toContain("actor-b");
		});
	});
});
