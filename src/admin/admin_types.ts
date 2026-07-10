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
 * A single flash message shown at the top of the next screen, with a severity
 * level driving how it is announced and styled (admin's own change/add
 * confirmations use `"success"`).
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
 * The header's user-tools block content (`#user-tools`). Authentication is
 * out of admin's scope, so the app supplies
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

/**
 * One operator-account row as consumed by `AdminPanel` (`admin_panel.tsx`):
 * the contract columns shared by the default users tables of all three
 * dialects (`sqliteAdminUsersTable`/`pgAdminUsersTable`/`mysqlAdminUsersTable`;
 * every timestamp is an epoch-millisecond number on each dialect, so the row
 * shape is uniform). A service may return rows that are a SUPERSET of this
 * shape (e.g. an extended table's app-specific columns) — that is the
 * ordinary covariant-return direction and the extra properties are simply
 * ignored by the panel.
 *
 * `passwordHash` is part of the contract (not just an incidental extra
 * column): `AdminPanel`'s accounts gate re-derives a `passwordStamp`
 * fingerprint from it on every request to invalidate a session whose
 * password changed since it was issued (see `admin_panel.tsx`'s
 * `derivePasswordStamp`). It is never rendered by any built-in view.
 */
export type AdminAccountsUserRow = {
	id: string;
	username: string;
	passwordHash: string;
	label: string | null;
	isActive: boolean;
	isSuperuser: boolean;
	permissions: string;
	lastLoginAt: number | null;
	createdAt: number;
	updatedAt: number;
};

/**
 * The structure an operator-accounts service (`SQLiteAdminAccounts` etc.) must
 * satisfy for `AdminPanelOptions.accounts.users`. Declared with method
 * shorthand deliberately: shorthand parameters are checked bivariantly under
 * `strictFunctionTypes`, so the dialect services — generic over their concrete
 * table and returning rows that are a superset of `AdminAccountsUserRow` —
 * stay assignable (an arrow-property declaration would check parameters
 * contravariantly and reject them). `AdminPanel` (`admin_panel.tsx`) uses
 * `authenticate` to derive the built-in login, `retrieve` to re-validate the
 * logged-in operator on every request, and `userPermissions` to build the
 * granted permission set.
 *
 * The remaining methods (`createUser` through `deleteUser`) are the
 * management surface an accounts management UI drives; they mirror the
 * dialect services' own split of concerns — `updateUser` touches only profile
 * fields (never the password or the permission set), `setPassword` and
 * `setUserPermissions` own those two separately, and `countActiveSuperusers`
 * exists so such a UI can refuse to deactivate, demote, or delete the last
 * active superuser.
 */
export type AdminAccountsUsers = {
	authenticate(credentials: {
		username: string;
		password: string;
	}): Promise<AdminAccountsUserRow | null>;
	retrieve(userId: string): Promise<AdminAccountsUserRow | undefined>;
	userPermissions(userId: string): Promise<string[]>;
	createUser(input: {
		username: string;
		password: string;
		label?: string | null;
		isActive?: boolean;
		isSuperuser?: boolean;
		permissions?: readonly string[];
	}): Promise<AdminAccountsUserRow>;
	updateUser(
		userId: string,
		patch: {
			username?: string;
			label?: string | null;
			isActive?: boolean;
			isSuperuser?: boolean;
		},
		/**
		 * When `protectLastActiveSuperuser` is `true`, a patch that would
		 * deactivate or demote the only remaining active superuser is rejected
		 * with `LastActiveSuperuserError` instead of applied — enforced by the
		 * dialect service as a single conditional UPDATE, not a separate
		 * check-then-act read (see `SQLiteAdminAccounts#updateUser`).
		 */
		options?: { protectLastActiveSuperuser?: boolean },
	): Promise<AdminAccountsUserRow | undefined>;
	setPassword(userId: string, password: string): Promise<void>;
	setUserPermissions(userId: string, permissions: readonly string[]): Promise<void>;
	listUsers(options?: {
		query?: string;
		limit?: number;
		offset?: number;
	}): Promise<AdminAccountsUserRow[]>;
	count(query?: string): Promise<number>;
	countActiveSuperusers(): Promise<number>;
	/**
	 * When `options.protectLastActiveSuperuser` is `true`, deleting the only
	 * remaining active superuser is rejected with `LastActiveSuperuserError`
	 * instead of applied (same single-statement guarding as `updateUser`).
	 */
	deleteUser(userId: string, options?: { protectLastActiveSuperuser?: boolean }): Promise<void>;
};

/**
 * One operator-group row as consumed by `AdminPanel` (`admin_panel.tsx`): the
 * contract columns shared by the default groups tables of all three dialects
 * (`sqliteAdminGroupsTable`/`pgAdminGroupsTable`/`mysqlAdminGroupsTable`; every
 * timestamp is an epoch-millisecond number on each dialect, so the row shape
 * is uniform). A service may return rows that are a SUPERSET of this shape
 * (e.g. an extended table's app-specific columns) — that is the ordinary
 * covariant-return direction and the extra properties are simply ignored by
 * the panel.
 */
export type AdminAccountsGroupRow = {
	id: string;
	name: string;
	permissions: string;
	createdAt: number;
	updatedAt: number;
};

/**
 * The structure an operator-groups service (`SQLiteAdminGroups` etc.) must
 * satisfy for `AdminPanelOptions.accounts.groups` (method shorthand for the
 * same bivariance reason as `AdminAccountsUsers`). `permissionsForUser`
 * resolves the union of the permission sets of every group the user belongs
 * to; `AdminPanel` (`admin_panel.tsx`) unions it with the user's own set
 * before checking.
 *
 * The remaining methods are the management surface an accounts management UI
 * drives, split the same way as `AdminAccountsUsers`: `updateGroup` touches
 * only the group's name, `setGroupPermissions` owns the permission set, and
 * `userGroups`/`setUserGroups` read and replace one user's memberships.
 */
export type AdminAccountsGroups = {
	permissionsForUser(userId: string): Promise<string[]>;
	listGroups(): Promise<AdminAccountsGroupRow[]>;
	createGroup(input: {
		name: string;
		permissions?: readonly string[];
	}): Promise<AdminAccountsGroupRow>;
	updateGroup(
		groupId: string,
		patch: { name?: string },
	): Promise<AdminAccountsGroupRow | undefined>;
	setGroupPermissions(groupId: string, permissions: readonly string[]): Promise<void>;
	groupPermissions(groupId: string): Promise<string[]>;
	deleteGroup(groupId: string): Promise<void>;
	userGroups(userId: string): Promise<AdminAccountsGroupRow[]>;
	setUserGroups(userId: string, groupIds: readonly string[]): Promise<void>;
};
