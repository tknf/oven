/**
 * Structural interfaces and row types that `AdminPanel` (`admin_panel.tsx`) uses to
 * receive each section (job operations, settings, audit log) via injection. To
 * avoid bringing the type differences of `JobsConsole`/`AuditLog` (implemented in
 * parallel across the SQLite/Postgres/MySQL dialects; drizzle's type system has no
 * common abstraction across dialects, see `sqlite_jobs_console.ts`/
 * `sqlite_audit_log.ts`) into admin, only the shape of public methods is defined
 * structurally here (same for `FeatureFlags` in `kv/feature_flags.ts` and
 * `MaintenanceMode` in `security/maintenance_mode.ts`).
 *
 * This module depends on (imports) none of drizzle, kv, security, or jobs. Whether
 * real classes are assignable to these structures is guaranteed by typecheck.
 */

/** One row displayed by the job operations screen (only the columns used for display, from `SQLiteJobRecordTable` etc.). */
export type AdminJobRow = {
	id: string;
	name: string;
	priority: number;
	runAt: number;
	attempts: number;
	failedAt: number | null;
	lastError: string | null;
};

/**
 * The structure `JobsConsole` (`SQLiteJobsConsole` etc.) must satisfy. Real
 * classes' `listPending`/`listFailed` are loosely typed because table injection is
 * `AnySQLiteColumn` (only the column name is known; the value is `any`), so the
 * actual return becomes `Promise<{ [x: string]: any }[]>` and cannot be assigned to
 * `AdminJobRow[]`. Hence the boundary here is received as `Record<string,
 * unknown>[]`, normalized into `AdminJobRow` on the `admin_panel.tsx` side.
 */
export type AdminJobsConsole = {
	listPending(limit?: number): Promise<Record<string, unknown>[]>;
	listFailed(limit?: number): Promise<Record<string, unknown>[]>;
	retryFailed(id: string): Promise<boolean>;
	deleteJob(id: string): Promise<boolean>;
};

/** The structure `FeatureFlags` must satisfy. */
export type AdminFeatureFlags = {
	enabled(name: string): Promise<boolean>;
	enable(name: string): Promise<void>;
	disable(name: string): Promise<void>;
};

/** The structure `MaintenanceMode` must satisfy. */
export type AdminMaintenanceMode = {
	enabled(): Promise<boolean>;
	enable(): Promise<void>;
	disable(): Promise<void>;
};

/** One row displayed by the audit log screen (corresponding to columns of `SQLiteAuditRecordTable` etc.). */
export type AdminAuditRow = {
	id: string;
	actor: string;
	action: string;
	target: string;
	changes: string | null;
	createdAt: number;
};

/**
 * The structure `AuditLog` (`SQLiteAuditLog` etc.) must satisfy. `list` has the
 * same reason as `AdminJobsConsole` (table injection is loosely typed via
 * `AnySQLiteColumn`), so the return becomes `Promise<{ [x: string]: any }[]>` and
 * cannot be assigned to `AdminAuditRow[]`. The boundary is received as
 * `Record<string, unknown>[]`, normalized into `AdminAuditRow` on the
 * `admin_panel.tsx` side.
 */
export type AdminAuditLog = {
	list(options?: {
		actor?: string;
		action?: string;
		target?: string;
		limit?: number;
	}): Promise<Record<string, unknown>[]>;
	record(entry: {
		actor: string;
		action: string;
		target: string;
		changes?: unknown;
	}): Promise<void>;
};

/**
 * A single flash message shown at the top of the next screen, mirroring the
 * `django.contrib.messages` framework's severity levels used by admin's own
 * change/add confirmations.
 */
export type AdminMessage = {
	level: "success" | "error" | "info";
	text: string;
};

/**
 * One link rendered in the header's user-tools block (e.g. "View site", "Log
 * out"). `method: "post"` renders as a `<form method="post">` + submit button
 * (needed for a logout link, which must not be a plain `GET`); omitted or
 * `"get"` renders as a plain `<a>`.
 */
export type AdminUserToolLink = {
	label: string;
	href: string;
	method?: "get" | "post";
};

/**
 * The header's user-tools block content (Django admin's `#user-tools`
 * equivalent). Authentication is out of admin's scope, so the app supplies
 * this entirely via `AdminPanelOptions.userTools` (same optional-injection
 * pattern as `csrf`/`audit`/`session`); when not injected, the block renders
 * nothing.
 */
export type AdminUserTools = {
	/** Full greeting text to show first (e.g. `"Welcome, admin."`). Rendered as-is; admin does not prepend any wording of its own. */
	greeting?: string;
	/** Links shown after the greeting (e.g. "View site", "Change password", "Log out"). */
	links?: AdminUserToolLink[];
};
