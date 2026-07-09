/**
 * Mount base for a unified admin panel, in oven's
 * explicit-registration style. Like `MailPreviewHandler`
 * (`src/mailer/mail_preview_handler.ts`), this is a `RouteHandler` subclass with
 * screens that an app explicitly mounts via `app.route("/admin", new AdminPanel({...}))`.
 * Whether to mount in production and SecureHeaders are the app's responsibility, but
 * the panel itself hard-codes authorization (`authorize`) as mandatory. CSRF
 * verification (`csrf`; `Csrf` from `security/csrf.ts`) is enforced on write routes
 * **only when injected** (SEC-301: to lean toward a safe-by-default posture, a
 * warning-only is emitted on the first unsafe-method request when not injected).
 *
 * Job operations (`jobs`), settings (`settings`), audit log viewing (`audit`), and
 * resource CRUD (`resources`; `AdminResource` from `admin_resource.ts`) only render
 * and get routes **when their config is injected**.
 * There is no JS; operations are completed with native `<form method="post">` +
 * 303 See Other (when `csrf` is injected, each form embeds the token via a hidden
 * input). Since the app decides the mount base (e.g. `/admin`), internal
 * links/redirects are built by prefixing `AdminPanelOptions.basePath`
 * (default `"/admin"`) rather than using relative links.
 *
 * CSS is inlined into `<style>` by `AdminLayout` from `ADMIN_CSS` (a string constant
 * in `admin_styles.ts`), so this panel itself has no asset-serving route (keeps
 * runtime code fs-independent).
 *
 * Per `RouteHandler`'s constraint 2 (`src/routing/route_handler.ts`), `middleware()`/
 * `register()` are called during the base constructor (`super()`), so overrides must
 * be written as prototype methods. `register()` registers only the dashboard
 * (`GET "/"`); the job/settings/audit routes are registered additionally from
 * `wireSections()`, called after `super()` completes (after `panelOptions` is
 * assigned). Hono applies all middleware registered on an instance
 * (`this.use` via `middleware()`) to every matching route regardless of registration
 * order, so the authorization middleware also applies to section routes added later
 * (verified in `admin_panel.test.ts`). `panelOptions` itself is assigned once in the
 * constructor and immutable thereafter, but each handler follows the
 * `MailPreviewHandler` precedent and consistently references `this.panelOptions` at
 * request time (inside a closure).
 */
import type { Context, Env, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { RouteHandler } from "../routing/route_handler.js";
import type { Csrf } from "../security/csrf.js";
import { bindAdminT } from "./admin_catalog.js";
import type { AdminT } from "./admin_catalog.js";
import type { AdminResource } from "./admin_resource.js";
import { AdminAuditView } from "./admin_audit_view.js";
import { AdminJobsView } from "./admin_jobs_view.js";
import type { AdminNavItem } from "./admin_layout.js";
import { AdminLayout } from "./admin_layout.js";
import { AdminResourceFormView } from "./admin_resource_form_view.js";
import { AdminResourceListView } from "./admin_resource_list_view.js";
import { AdminResourceShowView } from "./admin_resource_show_view.js";
import { AdminSettingsView } from "./admin_settings_view.js";
import type {
	AdminAuditLog,
	AdminAuditRow,
	AdminFeatureFlags,
	AdminJobRow,
	AdminJobsConsole,
	AdminMaintenanceMode,
} from "./admin_types.js";

/** Number of items per page in the resource list. */
const PAGE_SIZE = 20;

/**
 * Returns a shallow copy of `value` with `key` removed, if `value` is an object.
 * Non-objects are returned as-is. Used by the update handler so that, even if a
 * primary key column ends up in the validated value, the row's identity (the `id`
 * from the URL) is not overwritten (because `SQLiteModel#update` etc. unconditionally
 * `.set()`s `patch`).
 */
const withoutKey = (value: unknown, key: string): unknown => {
	if (typeof value !== "object" || value === null) return value;
	const rest: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		if (k !== key) rest[k] = v;
	}
	return rest;
};

/**
 * Converts an unknown value to a string. Since `String(unknown)` can produce
 * `"[object Object]"` when passed an object (as the lint rule `no-base-to-string`
 * flags), only string/number/bigint are converted; anything else (object,
 * undefined, etc.) becomes an empty string.
 */
const stringify = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint") return String(value);
	return "";
};

/**
 * Normalizes the loosely-typed return of `AdminJobsConsole#listPending`/`listFailed`
 * (`Record<string, unknown>[]`; the real class is loosely typed via `AnySQLiteColumn`)
 * into a display-ready `AdminJobRow`. Since drizzle's `.select()` returns JS property
 * names (camelCase), it is referenced via `runAt`/`failedAt`/`lastError`.
 */
const toJobRow = (row: Record<string, unknown>): AdminJobRow => ({
	id: stringify(row.id),
	name: stringify(row.name),
	priority: Number(row.priority ?? 0),
	runAt: Number(row.runAt ?? 0),
	attempts: Number(row.attempts ?? 0),
	failedAt: row.failedAt == null ? null : Number(row.failedAt),
	lastError: row.lastError == null ? null : stringify(row.lastError),
});

/**
 * Normalizes the loosely-typed return of `AdminAuditLog#list`
 * (`Record<string, unknown>[]`) into a display-ready `AdminAuditRow`. Same reason
 * and same convention as `toJobRow`.
 */
const toAuditRow = (row: Record<string, unknown>): AdminAuditRow => ({
	id: stringify(row.id),
	actor: stringify(row.actor),
	action: stringify(row.action),
	target: stringify(row.target),
	changes: row.changes == null ? null : stringify(row.changes),
	createdAt: Number(row.createdAt ?? 0),
});

export type AdminPanelOptions<E extends Env = Env> = {
	/**
	 * Admin access authorization callback (required). Assumes reuse of the existing
	 * `Guard`/`Policy`; the core does not assume an admin-only role (e.g.
	 * `authorize: (c) => adminPolicy.canAccess(c.get("user"))`).
	 */
	authorize: (c: Context<E>) => boolean | Promise<boolean>;
	/** Brand name shown in the screen header/title. Default `"Admin"`. */
	brand?: string;
	/** Response status when `authorize` returns `false`. Default `403`. */
	denyStatus?: ContentfulStatusCode;
	/** This panel's mount base path. Default `"/admin"`. Used to prefix internal links/redirects. */
	basePath?: string;
	/**
	 * CSRF verification (`Csrf` from `security/csrf.ts`). When injected, `csrf.verify`
	 * applies to all write routes (`SAFE_METHODS` self-skip), and each form embeds a
	 * hidden input derived from `csrf.csrfToken(c)`. When not injected, neither
	 * verification nor the hidden input is emitted, as before (backward compatible),
	 * but a one-time warning is issued on the first unsafe-method request (SEC-301).
	 */
	csrf?: Csrf<E>;
	/** Job operations screen. No rendering or routes if not injected. */
	jobs?: { console: AdminJobsConsole };
	/** Settings screen (feature flags/maintenance mode). Each section may be omitted independently. */
	settings?: {
		featureFlags?: { flags: AdminFeatureFlags; names: string[] };
		maintenance?: AdminMaintenanceMode;
	};
	/** Audit log viewing screen. If `actor` is not specified, the recorded actor defaults to `"admin"`. */
	audit?: { log: AdminAuditLog; actor?: (c: Context<E>) => string | Promise<string> };
	/** Resource CRUD screen (`AdminResource` from `admin_resource.ts`). No rendering or routes if not injected. */
	resources?: AdminResource[];
};

/** `RouteHandler` subclass that serves the unified admin panel, mounted explicitly by the app. */
export class AdminPanel<E extends Env = Env> extends RouteHandler<E> {
	/**
	 * `options` collides with Hono's reserved instance member name (used for HTTP
	 * OPTIONS method registration; see `route_handler.ts` constraint 1), so the field
	 * is named `panelOptions` instead.
	 */
	private panelOptions: AdminPanelOptions<E> | undefined;

	/**
	 * Becomes `true` once an unsafe-method request has been received with `csrf` not
	 * injected (used by `warnCsrfMissingOnce` to prevent duplicate warnings).
	 */
	private csrfMissingWarned = false;

	constructor(options: AdminPanelOptions<E>) {
		super();
		this.panelOptions = options;
		this.wireSections();
	}

	protected middleware(): MiddlewareHandler<E>[] {
		return [
			async (c, next) => {
				this.warnCsrfMissingOnce(c);
				await next();
			},
			async (c, next) => {
				const options = this.panelOptions;
				if (!options) return c.text("admin not configured", 500);

				const allowed = await options.authorize(c);
				if (!allowed) return c.text("Forbidden", options.denyStatus ?? 403);

				await next();
			},
			async (c, next) => {
				const csrf = this.panelOptions?.csrf;
				if (!csrf) return next();
				return csrf.verify(c, next);
			},
		];
	}

	/**
	 * `console.warn`s that CSRF is unwired only once, on the first unsafe-method
	 * request (anything other than `GET`/`HEAD`/`OPTIONS`) received while
	 * `panelOptions.csrf` is not injected. Not emitted for GET-only access (leans
	 * toward a safe-by-default posture while not breaking existing backward-compat
	 * tests).
	 */
	private warnCsrfMissingOnce(c: Context<E>): void {
		if (this.panelOptions?.csrf || this.csrfMissingWarned) return;
		if (["GET", "HEAD", "OPTIONS"].includes(c.req.method.toUpperCase())) return;

		this.csrfMissingWarned = true;
		console.warn(
			"AdminPanel has no csrf wired. Pass the `csrf` option or verify upstream for CSRF protection.",
		);
	}

	protected register(): void {
		this.get("/", (c) => {
			const options = this.panelOptions;
			if (!options) return c.text("admin not configured", 500);

			const brand = options.brand ?? "Admin";
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout brand={brand} nav={this.buildNav(t)} lang={c.get("language") ?? "en"}>
					<h2>{t("dashboard.welcome")}</h2>
					<p>{t("dashboard.empty")}</p>
				</AdminLayout>,
			);
		});
	}

	/** Resolves `panelOptions.basePath` (default `"/admin"`). Named this way because `basePath` is a Hono-reserved name. */
	private resolveBasePath(): string {
		return this.panelOptions?.basePath ?? "/admin";
	}

	/** Issues a token string only when `panelOptions.csrf` is injected. `null` when not injected (no hidden input in forms). */
	private csrfToken(c: Context<E>): string | null {
		return this.panelOptions?.csrf?.csrfToken(c) ?? null;
	}

	/** Builds the nav item list, including only wired sections (jobs/settings/audit). */
	private buildNav(t: AdminT): AdminNavItem[] {
		const options = this.panelOptions;
		const basePath = this.resolveBasePath();
		const nav: AdminNavItem[] = [{ href: `${basePath}/`, label: t("nav.dashboard") }];
		if (!options) return nav;

		if (options.jobs) nav.push({ href: `${basePath}/jobs`, label: t("nav.jobs") });
		if (options.settings) nav.push({ href: `${basePath}/settings`, label: t("nav.settings") });
		if (options.audit) nav.push({ href: `${basePath}/audit`, label: t("nav.audit") });
		for (const resource of options.resources ?? []) {
			nav.push({ href: `${basePath}/resources/${resource.key}`, label: resource.label });
		}
		return nav;
	}

	/**
	 * Records one audit log entry if `panelOptions.audit` is injected. Does nothing if
	 * not injected (policy: "recording destination is config-injected; skip if omitted").
	 */
	private async recordAudit(
		c: Context<E>,
		action: string,
		target: string,
		changes?: unknown,
	): Promise<void> {
		const audit = this.panelOptions?.audit;
		if (!audit) return;

		const actor = audit.actor ? await audit.actor(c) : "admin";
		await audit.log.record({ actor, action, target, changes });
	}

	/**
	 * Called after `super()` completes (after `panelOptions` is assigned), and
	 * additionally registers routes only for injected sections. Since `register()`
	 * registers only the dashboard, this is the single branch point that keeps
	 * uninjected sections from getting routes.
	 */
	private wireSections(): void {
		const options = this.panelOptions;
		if (!options) return;

		if (options.jobs) this.wireJobs();
		if (options.settings) this.wireSettings();
		if (options.audit) this.wireAudit();
		if (options.resources && options.resources.length > 0) this.wireResources();
	}

	/** Registers `GET /jobs`, `POST /jobs/:id/retry`, and `POST /jobs/:id/delete`. */
	private wireJobs(): void {
		this.get("/jobs", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const [pending, failed] = await Promise.all([
				options.jobs.console.listPending(),
				options.jobs.console.listFailed(),
			]);
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(t)}
					lang={c.get("language") ?? "en"}
				>
					<AdminJobsView
						basePath={this.resolveBasePath()}
						pending={pending.map(toJobRow)}
						failed={failed.map(toJobRow)}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/jobs/:id/retry", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const id = c.req.param("id");
			const ok = await options.jobs.console.retryFailed(id);
			await this.recordAudit(c, "job.retry", id, { ok });
			return c.redirect(`${this.resolveBasePath()}/jobs`, 303);
		});

		this.post("/jobs/:id/delete", async (c) => {
			const options = this.panelOptions;
			if (!options?.jobs) return c.notFound();

			const id = c.req.param("id");
			const ok = await options.jobs.console.deleteJob(id);
			await this.recordAudit(c, "job.delete", id, { ok });
			return c.redirect(`${this.resolveBasePath()}/jobs`, 303);
		});
	}

	/** Registers `GET /settings`, `POST /settings/flags/:name`, and `POST /settings/maintenance`. */
	private wireSettings(): void {
		this.get("/settings", async (c) => {
			const options = this.panelOptions;
			if (!options?.settings) return c.notFound();

			const { featureFlags, maintenance } = options.settings;
			const flags = featureFlags
				? await Promise.all(
						featureFlags.names.map(async (name) => ({
							name,
							enabled: await featureFlags.flags.enabled(name),
						})),
					)
				: [];
			const maintenanceState = maintenance ? { enabled: await maintenance.enabled() } : null;
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(t)}
					lang={c.get("language") ?? "en"}
				>
					<AdminSettingsView
						basePath={this.resolveBasePath()}
						flags={flags}
						maintenance={maintenanceState}
						csrfToken={this.csrfToken(c)}
						t={t}
					/>
				</AdminLayout>,
			);
		});

		this.post("/settings/flags/:name", async (c) => {
			const featureFlags = this.panelOptions?.settings?.featureFlags;
			if (!featureFlags) return c.notFound();

			const name = c.req.param("name");
			const body = await c.req.parseBody();
			const op = body.op === "enable" ? "enable" : "disable";
			if (op === "enable") await featureFlags.flags.enable(name);
			else await featureFlags.flags.disable(name);

			await this.recordAudit(c, op === "enable" ? "flag.enable" : "flag.disable", name);
			return c.redirect(`${this.resolveBasePath()}/settings`, 303);
		});

		this.post("/settings/maintenance", async (c) => {
			const maintenance = this.panelOptions?.settings?.maintenance;
			if (!maintenance) return c.notFound();

			const body = await c.req.parseBody();
			const op = body.op === "enable" ? "enable" : "disable";
			if (op === "enable") await maintenance.enable();
			else await maintenance.disable();

			await this.recordAudit(
				c,
				op === "enable" ? "maintenance.enable" : "maintenance.disable",
				"maintenance",
			);
			return c.redirect(`${this.resolveBasePath()}/settings`, 303);
		});
	}

	/** Registers `GET /audit`. */
	private wireAudit(): void {
		this.get("/audit", async (c) => {
			const options = this.panelOptions;
			if (!options?.audit) return c.notFound();

			const actor = c.req.query("actor") || undefined;
			const action = c.req.query("action") || undefined;
			const target = c.req.query("target") || undefined;
			const rows = await options.audit.log.list({ actor, action, target });
			const t = bindAdminT(c);

			return c.html(
				<AdminLayout
					brand={options.brand ?? "Admin"}
					nav={this.buildNav(t)}
					lang={c.get("language") ?? "en"}
				>
					<AdminAuditView
						basePath={this.resolveBasePath()}
						rows={rows.map(toAuditRow)}
						filter={{ actor, action, target }}
						t={t}
					/>
				</AdminLayout>,
			);
		});
	}

	/**
	 * Registers list/show/create/edit/delete routes for each resource in
	 * `panelOptions.resources`. `key` is embedded literally into the route path, and
	 * each handler resolves it at request time via
	 * `this.panelOptions?.resources?.find((r) => r.key === key)` (same
	 * request-time-reference convention used across the panel, as in `register()`).
	 * Write routes (create/edit/delete) are registered only for resources where
	 * `resource.canWrite()` (whether `form()` is implemented) is `true`.
	 */
	private wireResources(): void {
		const resources = this.panelOptions?.resources ?? [];

		for (const resource of resources) {
			const key = resource.key;
			const resolve = (): AdminResource | undefined =>
				this.panelOptions?.resources?.find((candidate) => candidate.key === key);

			this.get(`/resources/${key}`, async (c) => {
				const options = this.panelOptions;
				const target = resolve();
				if (!options || !target) return c.notFound();

				const cursor = c.req.query("cursor") || undefined;
				const query = c.req.query("q") ?? "";
				const where = query ? target.searchWhere(query) : undefined;
				const { rows, nextCursor, hasMore } = await target.model.paginate({
					limit: PAGE_SIZE,
					cursor,
					direction: "desc",
					where,
				});
				const t = bindAdminT(c);

				return c.html(
					<AdminLayout
						brand={options.brand ?? "Admin"}
						nav={this.buildNav(t)}
						lang={c.get("language") ?? "en"}
					>
						<AdminResourceListView
							basePath={this.resolveBasePath()}
							resourceKey={key}
							label={target.label}
							columns={target.columns().map((column) => column.name)}
							rows={rows}
							primaryKey={target.primaryKey}
							canWrite={target.canWrite()}
							searchEnabled={(target.searchColumns?.() ?? []).length > 0}
							query={query}
							nextCursor={nextCursor}
							hasMore={hasMore}
							csrfToken={this.csrfToken(c)}
							t={t}
						/>
					</AdminLayout>,
				);
			});

			if (resource.canWrite()) {
				this.get(`/resources/${key}/new`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const binding = form.bind();
					const t = bindAdminT(c);
					return c.html(
						<AdminLayout
							brand={options.brand ?? "Admin"}
							nav={this.buildNav(t)}
							lang={c.get("language") ?? "en"}
						>
							<AdminResourceFormView
								basePath={this.resolveBasePath()}
								resourceKey={key}
								label={target.label}
								mode="new"
								form={binding}
								action={`${this.resolveBasePath()}/resources/${key}`}
								csrfToken={this.csrfToken(c)}
								t={t}
							/>
						</AdminLayout>,
					);
				});
			}

			this.get(`/resources/${key}/:id`, async (c) => {
				const options = this.panelOptions;
				const target = resolve();
				if (!options || !target) return c.notFound();

				const row = await target.model.retrieve(c.req.param("id"));
				if (!row) return c.notFound();

				const t = bindAdminT(c);
				return c.html(
					<AdminLayout
						brand={options.brand ?? "Admin"}
						nav={this.buildNav(t)}
						lang={c.get("language") ?? "en"}
					>
						<AdminResourceShowView
							basePath={this.resolveBasePath()}
							resourceKey={key}
							label={target.label}
							columns={target.columns().map((column) => column.name)}
							row={row}
							primaryKey={target.primaryKey}
							canWrite={target.canWrite()}
							t={t}
						/>
					</AdminLayout>,
				);
			});

			if (resource.canWrite()) {
				this.post(`/resources/${key}`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const result = await form.validate(await c.req.parseBody());
					if (!result.ok) {
						const binding = form.bind({ errors: result.errors, values: result.values });
						const t = bindAdminT(c);
						return c.html(
							<AdminLayout
								brand={options.brand ?? "Admin"}
								nav={this.buildNav(t)}
								lang={c.get("language") ?? "en"}
							>
								<AdminResourceFormView
									basePath={this.resolveBasePath()}
									resourceKey={key}
									label={target.label}
									mode="new"
									form={binding}
									action={`${this.resolveBasePath()}/resources/${key}`}
									csrfToken={this.csrfToken(c)}
									t={t}
								/>
							</AdminLayout>,
							422,
						);
					}

					const created = await target.model.create(result.value);
					await this.recordAudit(
						c,
						"resource.create",
						`${key}/${stringify(created[target.primaryKey])}`,
					);
					return c.redirect(`${this.resolveBasePath()}/resources/${key}`, 303);
				});

				this.get(`/resources/${key}/:id/edit`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const id = c.req.param("id");
					const row = await target.model.retrieve(id);
					if (!row) return c.notFound();

					const binding = form.bind({ values: form.toInput(row) });
					const t = bindAdminT(c);
					return c.html(
						<AdminLayout
							brand={options.brand ?? "Admin"}
							nav={this.buildNav(t)}
							lang={c.get("language") ?? "en"}
						>
							<AdminResourceFormView
								basePath={this.resolveBasePath()}
								resourceKey={key}
								label={target.label}
								mode="edit"
								form={binding}
								action={`${this.resolveBasePath()}/resources/${key}/${id}`}
								id={id}
								csrfToken={this.csrfToken(c)}
								t={t}
							/>
						</AdminLayout>,
					);
				});

				this.post(`/resources/${key}/:id`, async (c) => {
					const options = this.panelOptions;
					const target = resolve();
					if (!options || !target) return c.notFound();
					const form = target.form?.();
					if (!form) return c.notFound();

					const id = c.req.param("id");
					const existing = await target.model.retrieve(id);
					if (!existing) return c.notFound();

					const result = await form.validate(await c.req.parseBody());
					if (!result.ok) {
						const binding = form.bind({ errors: result.errors, values: result.values });
						const t = bindAdminT(c);
						return c.html(
							<AdminLayout
								brand={options.brand ?? "Admin"}
								nav={this.buildNav(t)}
								lang={c.get("language") ?? "en"}
							>
								<AdminResourceFormView
									basePath={this.resolveBasePath()}
									resourceKey={key}
									label={target.label}
									mode="edit"
									form={binding}
									action={`${this.resolveBasePath()}/resources/${key}/${id}`}
									id={id}
									csrfToken={this.csrfToken(c)}
									t={t}
								/>
							</AdminLayout>,
							422,
						);
					}

					/**
					 * The row's identity is authoritatively the `id` from the URL, so even if
					 * the primary key column (`target.primaryKey`) ends up in the validated
					 * value, the row's primary key value must not be overwritten; the primary
					 * key is stripped before passing to `update`. Allowlisting non-primary-key
					 * columns is the app's `Form#schema()`'s responsibility (the contract is
					 * that admin does not use a schema that fails to strip unknown keys), so it
					 * is not done here (this stripping is not applied on create, since it would
					 * break tables where admin inputs a natural key such as `code`).
					 */
					await target.model.update(id, withoutKey(result.value, target.primaryKey));
					await this.recordAudit(c, "resource.update", `${key}/${id}`);
					return c.redirect(`${this.resolveBasePath()}/resources/${key}`, 303);
				});

				this.post(`/resources/${key}/:id/delete`, async (c) => {
					const target = resolve();
					if (!target) return c.notFound();

					const id = c.req.param("id");
					const deleted = await target.model.delete(id);
					await this.recordAudit(c, "resource.delete", `${key}/${id}`, {
						ok: deleted !== undefined,
					});
					return c.redirect(`${this.resolveBasePath()}/resources/${key}`, 303);
				});
			}
		}
	}
}
