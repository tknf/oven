/**
 * SQLite (sqlite-core) implementation of admin-panel operator accounts: a users
 * table (id, username, password hash, active/superuser flags, a JSON permission
 * set, timestamps) plus a service class (`SQLiteAdminAccounts`) for creating,
 * authenticating, and managing those users.
 *
 * Injecting an arbitrary table over Drizzle (sqlite-core) follows the same
 * convention as `SQLiteAuditLog` in `audit/sqlite_audit_log.ts` (accepting a
 * column contract, typing via `AnySQLiteColumn`, constructor injection of
 * db/table). Per the dialect-specific parallel-implementation convention (see
 * `model/sqlite_model.ts`), this file is SQLite-only and shares no abstraction
 * with other dialects; only the method vocabulary and algorithm are meant to be
 * portable.
 *
 * **Username normalization**: usernames are normalized (trimmed and lowercased)
 * at this service's boundary in `createUser`/`findByUsername`/`authenticate`/
 * `updateUser`. Rationale: default MySQL collations compare strings
 * case-insensitively while SQLite and Postgres do not, so without normalization
 * the same pair of usernames could collide on one dialect and coexist on
 * another. Normalizing before every write and lookup makes uniqueness and login
 * behave identically across dialects.
 *
 * **Passwords**: hashing and verification reuse `hashPassword`/`verifyPassword`
 * from `auth/password.ts` (PBKDF2-HMAC-SHA256, self-describing storage format).
 * Password length is bounded above by `MAX_PASSWORD_LENGTH` so PBKDF2's
 * preprocessing of attacker-supplied input stays DoS-bounded, and below by the
 * configurable `minPasswordLength` (default 8).
 *
 * **Extension recipe**: apps that need extra columns spread
 * `sqliteAdminUserColumns()` into their own `sqliteTable(...)` definition (see
 * that factory's JSDoc). The resulting table still satisfies
 * `SQLiteAdminUserRecordTable`, and `SQLiteAdminAccounts` is generic over the
 * concrete table so the extra columns stay typed on inputs and returned rows.
 *
 * **Opt-in account lockout**: apps that want failed-attempt lockout spread
 * `sqliteAdminUserLockoutColumns()` into the same table (alongside
 * `sqliteAdminUserColumns()`) and pass a `lockout` option to the constructor.
 * The columns and the option are both optional and independent of each
 * other's presence: `authenticate` only reads/writes `failedAttempts`/
 * `lockedUntil` when `lockout` is configured, and `unlockUser` works off the
 * columns alone regardless of whether `lockout` was configured. See
 * `authenticate`'s JSDoc for the algorithm.
 *
 * The type of `db` is made generic over `TSchema` for the same reason as
 * `SQLiteModel` (accepting a `db` built by passing a concrete schema, e.g.
 * `drizzle(client, { schema })`, as-is).
 */
import { and, asc, count as countRows, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
	AnySQLiteColumn,
	BaseSQLiteDatabase,
	SQLiteTable,
	TableConfig,
} from "drizzle-orm/sqlite-core";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { LastActiveSuperuserError } from "./admin_accounts_errors.js";
import { parseStoredPermissions } from "./admin_permissions.js";

/** Default lower bound on password length (overridable via `SQLiteAdminAccountsOptions#minPasswordLength`). */
const DEFAULT_MIN_PASSWORD_LENGTH = 8;

/**
 * Hard upper bound on password length. PBKDF2 preprocesses the whole input
 * before iterating, so accepting unbounded input would let a client burn server
 * CPU with megabyte-sized "passwords"; 1024 characters is far beyond any real
 * passphrase while keeping the preprocessing cost bounded.
 */
const MAX_PASSWORD_LENGTH = 1024;

/** Default number of rows returned by `listUsers` when `limit` is not specified. */
const DEFAULT_LIST_LIMIT = 50;

/**
 * Fixed dummy hash verified against when `authenticate` finds no matching user,
 * so PBKDF2 always runs and response time does not reveal whether an account
 * exists (see `verifyPassword`'s JSDoc in `auth/password.ts`). Pre-generated
 * once with `hashPassword` from a random throwaway password at the default
 * iteration count (100,000), so its verification cost is comparable to a real
 * stored hash.
 */
const DUMMY_PASSWORD_HASH =
	"pbkdf2$100000$h1ah0/bBaoq/zeThpnMBqw==$5EnlJn1FFicLwImnsBGYSstP2yzJqe3BzB3H0khohuc=";

/**
 * Normalizes a username (trim + lowercase). Applied at the service boundary in
 * `createUser`/`findByUsername`/`authenticate`/`updateUser`; see the module
 * JSDoc for the cross-dialect rationale.
 */
const normalizeUsername = (username: string): string => username.trim().toLowerCase();

/**
 * Escapes LIKE pattern wildcard characters (`%`/`_`) and the escape character
 * itself (`\`) so user input in `listUsers`/`count` cannot widen the match
 * scope. Same convention as the admin panel's search (`AdminResource#searchWhere`);
 * duplicated locally so the accounts service does not depend on `AdminResource`.
 */
const escapeLikePattern = (value: string): string =>
	value.replace(/[\\%_]/g, (char) => `\\${char}`);

/**
 * The type of a Drizzle table with the columns required by
 * `SQLiteAdminAccounts`. Uses `AnySQLiteColumn` (the same idea as
 * `SQLiteAuditRecordTable`) and does not care about the table name or other
 * column layout, so a table extended with app-specific columns still satisfies
 * it.
 */
export type SQLiteAdminUserRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: string; notNull: true }>;
	username: AnySQLiteColumn<{ data: string; notNull: true }>;
	passwordHash: AnySQLiteColumn<{ data: string; notNull: true }>;
	label: AnySQLiteColumn<{ data: string; notNull: false }>;
	isActive: AnySQLiteColumn<{ data: boolean; notNull: true }>;
	isSuperuser: AnySQLiteColumn<{ data: boolean; notNull: true }>;
	permissions: AnySQLiteColumn<{ data: string; notNull: true }>;
	lastLoginAt: AnySQLiteColumn<{ data: number; notNull: false }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
	updatedAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

/**
 * Row type of a table satisfying `SQLiteAdminUserRecordTable`, derived from
 * `$inferSelect` (same technique as `SQLiteModelRecord` in
 * `model/sqlite_model.ts`). For an extended table this includes the app's extra
 * columns.
 */
export type SQLiteAdminUserRecord<TUsers extends SQLiteAdminUserRecordTable> =
	TUsers["$inferSelect"];

/**
 * Column keys owned and managed by `SQLiteAdminAccounts`. They are excluded
 * from the extra-column input type (`SQLiteAdminUserExtraInput`) and stripped
 * from extra input at runtime, so callers can never smuggle e.g. a
 * `passwordHash` through the extension mechanism. `failedAttempts`/
 * `lockedUntil` are reserved here even though they are optional columns (see
 * `sqliteAdminUserLockoutColumns`): when a table has them, only `authenticate`
 * and `unlockUser` may write them.
 */
type ReservedAdminUserColumnKey =
	| "id"
	| "username"
	| "passwordHash"
	| "label"
	| "isActive"
	| "isSuperuser"
	| "permissions"
	| "lastLoginAt"
	| "createdAt"
	| "updatedAt"
	| "failedAttempts"
	| "lockedUntil";

/** Runtime counterpart of `ReservedAdminUserColumnKey`, used to strip reserved keys from extra-column input. */
const RESERVED_ADMIN_USER_COLUMN_KEYS: ReadonlySet<string> = new Set([
	"id",
	"username",
	"passwordHash",
	"label",
	"isActive",
	"isSuperuser",
	"permissions",
	"lastLoginAt",
	"createdAt",
	"updatedAt",
	"failedAttempts",
	"lockedUntil",
] satisfies ReservedAdminUserColumnKey[]);

/**
 * The app-specific extra columns of an extended table, as insert input. For the
 * plain `sqliteAdminUsersTable()` table this resolves to an empty object; for
 * an extended table the app's extra NOT NULL columns become required on
 * `createUser` (and optional on `updateUser`).
 */
export type SQLiteAdminUserExtraInput<TUsers extends SQLiteAdminUserRecordTable> = Omit<
	TUsers["$inferInsert"],
	ReservedAdminUserColumnKey
>;

/**
 * The contract-guaranteed base columns of an admin user row, with their
 * concrete data types. Used internally to read fields off rows of the generic
 * table (see `baseRow`).
 */
type AdminUserBaseRow = {
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
 * The structural contract for a table that additionally carries the opt-in
 * lockout columns (see `sqliteAdminUserLockoutColumns`), following the same
 * per-field `AnySQLiteColumn<{...}>` idiom as `SQLiteAdminUserRecordTable`.
 * `SQLiteAdminAccountsOptions#lockout` requires the constructor's table to
 * satisfy this (checked at runtime via `hasLockoutColumns`, since the base
 * `SQLiteAdminUserRecordTable` contract does not guarantee it).
 */
export type SQLiteAdminUserLockoutRecordTable = SQLiteAdminUserRecordTable & {
	failedAttempts: AnySQLiteColumn<{ data: number; notNull: true }>;
	lockedUntil: AnySQLiteColumn<{ data: number; notNull: false }>;
};

/**
 * Runtime type guard for `SQLiteAdminUserLockoutRecordTable`: whether `table`
 * actually carries `failedAttempts`/`lockedUntil`. The base contract doesn't
 * guarantee these (they're an opt-in extension), so this is checked once at
 * construction (when `SQLiteAdminAccountsOptions#lockout` is set) and again by
 * `unlockUser` (which works off column presence alone, independent of whether
 * `lockout` was configured).
 */
const hasLockoutColumns = <TUsers extends SQLiteAdminUserRecordTable>(
	table: TUsers,
): table is TUsers & SQLiteAdminUserLockoutRecordTable =>
	"failedAttempts" in table && "lockedUntil" in table;

/**
 * The lockout columns' concrete data types, read off a row of the generic
 * table the same way `AdminUserBaseRow` reads the base columns (see
 * `lockoutBaseRow`).
 */
type AdminUserLockoutBaseRow = {
	failedAttempts: number;
	lockedUntil: number | null;
};

/**
 * Copies extra-column input into a fresh record, dropping any reserved key.
 * The type level already excludes reserved keys (`SQLiteAdminUserExtraInput`),
 * so this is a runtime backstop for callers that bypass the types.
 */
const sanitizeExtraColumns = (extras: object): Record<string, unknown> => {
	/**
	 * `extras` arrives as a rest-destructured generic remainder, which TypeScript
	 * does not relate to an index signature; the contract's tables are plain
	 * column-value records, so `as` is used only here to read keys generically.
	 */
	const source = extras as Record<string, unknown>;
	const sanitized: Record<string, unknown> = {};
	for (const key of Object.keys(source)) {
		if (!RESERVED_ADMIN_USER_COLUMN_KEYS.has(key)) {
			sanitized[key] = source[key];
		}
	}
	return sanitized;
};

/**
 * Opt-in failed-attempt lockout configuration, passed as
 * `SQLiteAdminAccountsOptions#lockout`. Requires the constructor's table to
 * satisfy `SQLiteAdminUserLockoutRecordTable` (spread
 * `sqliteAdminUserLockoutColumns()` into it) — the constructor throws
 * otherwise. See `SQLiteAdminAccounts#authenticate` for the algorithm.
 */
export type SQLiteAdminAccountsLockoutOptions = {
	/** Number of consecutive failed attempts that locks the account. Must be at least 1. */
	maxAttempts: number;
	/** How long, in seconds, a triggered lock lasts before it expires on its own. Must be at least 1. */
	lockDurationSeconds: number;
};

/** Options for constructing a `SQLiteAdminAccounts`. */
export type SQLiteAdminAccountsOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `SQLiteModel`). */
	idGenerator?: IdGenerator;
	/** PBKDF2 iteration count forwarded to `hashPassword`. When omitted, `hashPassword`'s own default applies. */
	iterations?: number;
	/** Minimum accepted password length. Defaults to 8. The hard maximum is always 1024 (see `MAX_PASSWORD_LENGTH`). */
	minPasswordLength?: number;
	/**
	 * Opt-in per-account failed-attempt lockout. Omitted (the default) means
	 * `authenticate` never reads or writes `failedAttempts`/`lockedUntil`, even
	 * when the table has them.
	 */
	lockout?: SQLiteAdminAccountsLockoutOptions;
};

/** Input for `SQLiteAdminAccounts#createUser` (plus the extended table's extra columns, when present). */
export type SQLiteAdminAccountsCreateUserInput<TUsers extends SQLiteAdminUserRecordTable> = {
	username: string;
	password: string;
	label?: string | null;
	isActive?: boolean;
	isSuperuser?: boolean;
	permissions?: readonly string[];
} & SQLiteAdminUserExtraInput<TUsers>;

/** Patch for `SQLiteAdminAccounts#updateUser` (plus the extended table's extra columns, when present). */
export type SQLiteAdminAccountsUpdateUserPatch<TUsers extends SQLiteAdminUserRecordTable> = {
	username?: string;
	label?: string | null;
	isActive?: boolean;
	isSuperuser?: boolean;
} & Partial<SQLiteAdminUserExtraInput<TUsers>>;

/** Options accepted by `SQLiteAdminAccounts#updateUser` and `#deleteUser`. */
export type SQLiteAdminAccountsGuardOptions = {
	/**
	 * When `true`, refuses (throwing `LastActiveSuperuserError`) to apply a
	 * change that would leave zero active superusers. See `updateUser`/
	 * `deleteUser` for how the guard is enforced.
	 */
	protectLastActiveSuperuser?: boolean;
};

/** Query options for `SQLiteAdminAccounts#listUsers`. */
export type SQLiteAdminAccountsListOptions = {
	/** Matches `username` OR `label` with an escaped `LIKE '%query%'` (see `listUsers`). */
	query?: string;
	/** Maximum number of rows to return. Defaults to 50. */
	limit?: number;
	/** Number of rows to skip. Defaults to 0. */
	offset?: number;
};

/**
 * Operator-account service backed by a Drizzle sqlite-core table satisfying
 * `SQLiteAdminUserRecordTable`. Generic over the concrete table so extended
 * tables keep their extra columns typed on inputs and returned rows.
 */
export class SQLiteAdminAccounts<
	TUsers extends SQLiteAdminUserRecordTable,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly idGenerator: IdGenerator;
	private readonly iterations: number | undefined;
	private readonly minPasswordLength: number;
	private readonly lockout: SQLiteAdminAccountsLockoutOptions | undefined;
	/**
	 * The constructor's table, narrowed to `SQLiteAdminUserLockoutRecordTable`
	 * when it actually carries the lockout columns — `undefined` otherwise.
	 * Computed once regardless of whether `lockout` was configured, so
	 * `unlockUser` can work off column presence alone.
	 */
	private readonly lockoutColumns: (TUsers & SQLiteAdminUserLockoutRecordTable) | undefined;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: TUsers,
		options: SQLiteAdminAccountsOptions = {},
	) {
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
		this.iterations = options.iterations;
		this.minPasswordLength = options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH;
		this.lockoutColumns = hasLockoutColumns(table) ? table : undefined;
		if (options.lockout !== undefined) {
			if (options.lockout.maxAttempts < 1) {
				throw new Error("SQLiteAdminAccounts: lockout.maxAttempts must be at least 1");
			}
			if (options.lockout.lockDurationSeconds < 1) {
				throw new Error("SQLiteAdminAccounts: lockout.lockDurationSeconds must be at least 1");
			}
			if (this.lockoutColumns === undefined) {
				throw new Error(
					"SQLiteAdminAccounts: lockout requires failedAttempts/lockedUntil columns on the table — spread sqliteAdminUserLockoutColumns() into it",
				);
			}
		}
		this.lockout = options.lockout;
	}

	/**
	 * Creates a user. The username is normalized (trim + lowercase) and must not
	 * be empty; the password must be within
	 * [`minPasswordLength`, `MAX_PASSWORD_LENGTH`]. A duplicate username is
	 * pre-checked via `findByUsername` and throws; the table's UNIQUE index is
	 * the last line of defense, so a concurrent insert racing past the pre-check
	 * surfaces as a raw driver error. `permissions` defaults to `[]`,
	 * `isActive` to `true`, `isSuperuser` to `false`, and `lastLoginAt` starts
	 * as `null`. Returns the created row.
	 */
	async createUser(
		input: SQLiteAdminAccountsCreateUserInput<TUsers>,
	): Promise<SQLiteAdminUserRecord<TUsers>> {
		const { username, password, label, isActive, isSuperuser, permissions, ...extras } = input;
		const normalized = normalizeUsername(username);
		if (normalized === "") {
			throw new Error("SQLiteAdminAccounts#createUser: username must not be empty");
		}
		this.assertValidPassword(password);
		const existing = await this.findByUsername(normalized);
		if (existing !== undefined) {
			throw new Error(`SQLiteAdminAccounts#createUser: username "${normalized}" is already taken`);
		}
		const passwordHash = await this.hash(password);
		const now = Date.now();
		/**
		 * Reserved columns are written after the sanitized extras so they can
		 * never be overridden. Because the extra columns vary per table,
		 * TypeScript cannot statically relate this record to the generic
		 * `$inferInsert`, so `as` is used only when passing to `values` (same
		 * justification as `SQLiteModel#withAutoFields`).
		 */
		const values: Record<string, unknown> = {
			...sanitizeExtraColumns(extras),
			id: this.idGenerator.generate(),
			username: normalized,
			passwordHash,
			label: label ?? null,
			isActive: isActive ?? true,
			isSuperuser: isSuperuser ?? false,
			permissions: JSON.stringify(permissions ?? []),
			lastLoginAt: null,
			createdAt: now,
			updatedAt: now,
		};
		const [row] = await this.db
			.insert(this.table)
			.values(values as TUsers["$inferInsert"])
			.returning();
		return row;
	}

	/**
	 * Verifies a username/password pair and returns the user row on success,
	 * `null` on any failure. Failure modes are indistinguishable by timing as
	 * far as this method controls: when no user matches, `verifyPassword` still
	 * runs against a fixed dummy hash (account-enumeration defense per
	 * `auth/password.ts`); when the user exists, the hash is verified BEFORE the
	 * `isActive` check (and before the lockout check below), so an inactive or
	 * locked account costs the same as an active, unlocked one.
	 *
	 * A password longer than `MAX_PASSWORD_LENGTH` is rejected up front, before
	 * any user lookup, so the early return applies uniformly and cannot reveal
	 * whether the account exists. It keeps PBKDF2 preprocessing of
	 * unauthenticated input DoS-bounded — the same bound `MAX_PASSWORD_LENGTH`
	 * enforces on the write side, so no stored password can exceed it anyway.
	 *
	 * On success, `lastLoginAt` is set to the current time. `updatedAt` is
	 * deliberately NOT touched: it tracks profile edits, and a login is not an
	 * edit. The returned row carries the new `lastLoginAt` patched in memory (no
	 * re-select).
	 *
	 * **When `SQLiteAdminAccountsOptions#lockout` is configured** (and only
	 * then — otherwise this method never reads or writes `failedAttempts`/
	 * `lockedUntil`), a currently-locked account (`lockedUntil` in the future)
	 * still runs `verifyPassword` for timing parity, then always returns `null`
	 * with no writes, regardless of whether the password was correct — the same
	 * `null` an unlocked account gets for a wrong password, so a locked account
	 * is not distinguishable from a merely-wrong-password one. A wrong password
	 * on an unlocked account increments `failedAttempts` and conditionally sets
	 * `lockedUntil` in a single atomic UPDATE (`recordFailedAttempt`), counted
	 * regardless of `isActive` for the same timing-parity reason. A successful
	 * login resets both columns to their unlocked state as part of the same
	 * UPDATE that sets `lastLoginAt`. An expired lock (`lockedUntil` in the
	 * past) simply stops blocking; the stale counter is reset by the next
	 * successful login, or explicitly via `unlockUser`.
	 */
	async authenticate(credentials: {
		username: string;
		password: string;
	}): Promise<SQLiteAdminUserRecord<TUsers> | null> {
		if (credentials.password.length > MAX_PASSWORD_LENGTH) return null;
		const row = await this.findByUsername(credentials.username);
		if (row === undefined) {
			await verifyPassword(credentials.password, DUMMY_PASSWORD_HASH);
			return null;
		}
		const base = this.baseRow(row);
		const matched = await verifyPassword(credentials.password, base.passwordHash);
		if (this.lockout !== undefined && this.lockoutColumns !== undefined) {
			const lockoutBase = this.lockoutBaseRow(row);
			if (lockoutBase.lockedUntil !== null && lockoutBase.lockedUntil > Date.now()) {
				return null;
			}
			if (!matched) {
				await this.recordFailedAttempt(this.lockoutColumns, this.lockout, base.id);
				return null;
			}
		} else if (!matched) {
			return null;
		}
		if (!base.isActive) return null;
		const lastLoginAt = Date.now();
		const update: Record<string, unknown> = { lastLoginAt };
		if (this.lockout !== undefined) {
			update.failedAttempts = 0;
			update.lockedUntil = null;
		}
		await this.db
			.update(this.table)
			.set(update as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, base.id));
		/**
		 * Spreading the generic row loses its identity with `$inferSelect` at the
		 * type level even though only contract columns change, so `as` is used
		 * only here.
		 */
		return {
			...row,
			lastLoginAt,
			...(this.lockout !== undefined ? { failedAttempts: 0, lockedUntil: null } : {}),
		} as SQLiteAdminUserRecord<TUsers>;
	}

	/**
	 * Replaces the password of the given user (length-validated, then hashed)
	 * and touches `updatedAt`. A missing user is a no-op (the UPDATE simply
	 * matches zero rows).
	 */
	async setPassword(userId: string, password: string): Promise<void> {
		this.assertValidPassword(password);
		const passwordHash = await this.hash(password);
		await this.db
			.update(this.table)
			.set({ passwordHash, updatedAt: Date.now() } as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, userId));
	}

	/**
	 * Clears the lockout state of the given user (`failedAttempts = 0`,
	 * `lockedUntil = null`). A missing user is a no-op (the UPDATE simply
	 * matches zero rows), matching `setPassword`'s convention.
	 *
	 * Gated purely on column presence: this works whenever the table has
	 * `failedAttempts`/`lockedUntil`, whether or not
	 * `SQLiteAdminAccountsOptions#lockout` was passed to the constructor, and
	 * throws when the columns are absent.
	 */
	async unlockUser(userId: string): Promise<void> {
		if (this.lockoutColumns === undefined) {
			throw new Error(
				"SQLiteAdminAccounts#unlockUser: the table has no failedAttempts/lockedUntil columns — spread sqliteAdminUserLockoutColumns() into it",
			);
		}
		await this.db
			.update(this.table)
			.set({ failedAttempts: 0, lockedUntil: null } as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, userId));
	}

	/** Fetches a single user by id. Returns `undefined` if it doesn't exist. */
	async retrieve(userId: string): Promise<SQLiteAdminUserRecord<TUsers> | undefined> {
		const [row] = await this.db.select().from(this.table).where(eq(this.table.id, userId)).limit(1);
		return row;
	}

	/** Fetches a single user by username (normalized before lookup). Returns `undefined` if it doesn't exist. */
	async findByUsername(username: string): Promise<SQLiteAdminUserRecord<TUsers> | undefined> {
		const normalized = normalizeUsername(username);
		const [row] = await this.db
			.select()
			.from(this.table)
			.where(eq(this.table.username, normalized))
			.limit(1);
		return row;
	}

	/**
	 * Updates profile fields of the given user and touches `updatedAt`. A
	 * `username` in the patch is normalized and duplicate-pre-checked (excluding
	 * this user's own row). `passwordHash`/`permissions`/`id`/timestamps can
	 * never pass through this method: the update record is built explicitly from
	 * the allowed fields (plus sanitized extra columns), and dedicated methods
	 * own the rest (`setPassword`, `setUserPermissions`). Returns the updated
	 * row, or `undefined` when the user does not exist.
	 *
	 * When `options.protectLastActiveSuperuser` is `true` and the patch would
	 * deactivate (`isActive: false`) or demote (`isSuperuser: false`) the user,
	 * the guard is folded into the UPDATE's own `WHERE` clause (see
	 * `lastActiveSuperuserGuardCondition`) so the "is this the last active
	 * superuser" check and the write happen in a single statement — a
	 * check-then-act (`countActiveSuperusers` read, then a separate UPDATE)
	 * would let a concurrent request slip through between the two. If the
	 * guarded UPDATE matches zero rows, a follow-up `retrieve` tells apart the
	 * two reasons: the row still exists and is still an active superuser (the
	 * guard blocked the write; throws `LastActiveSuperuserError`), or the row
	 * doesn't exist at all (returns `undefined`, same as the unguarded path).
	 * That diagnostic read runs only on the zero-row branch, after the write
	 * already succeeded or failed — it never affects write safety.
	 */
	async updateUser(
		userId: string,
		patch: SQLiteAdminAccountsUpdateUserPatch<TUsers>,
		options: SQLiteAdminAccountsGuardOptions = {},
	): Promise<SQLiteAdminUserRecord<TUsers> | undefined> {
		const { username, label, isActive, isSuperuser, ...extras } = patch;
		const update: Record<string, unknown> = sanitizeExtraColumns(extras);
		if (username !== undefined) {
			const normalized = normalizeUsername(username);
			if (normalized === "") {
				throw new Error("SQLiteAdminAccounts#updateUser: username must not be empty");
			}
			const existing = await this.findByUsername(normalized);
			if (existing !== undefined && this.baseRow(existing).id !== userId) {
				throw new Error(
					`SQLiteAdminAccounts#updateUser: username "${normalized}" is already taken`,
				);
			}
			update.username = normalized;
		}
		if (label !== undefined) update.label = label;
		if (isActive !== undefined) update.isActive = isActive;
		if (isSuperuser !== undefined) update.isSuperuser = isSuperuser;
		update.updatedAt = Date.now();
		const guarded =
			options.protectLastActiveSuperuser === true && (isActive === false || isSuperuser === false);
		const where = guarded
			? and(eq(this.table.id, userId), this.lastActiveSuperuserGuardCondition())
			: eq(this.table.id, userId);
		/** `as` for the same per-table-varying-record reason as `createUser`. */
		const [row] = await this.db
			.update(this.table)
			.set(update as Partial<TUsers["$inferInsert"]>)
			.where(where)
			.returning();
		if (row !== undefined) return row;
		if (!guarded) return undefined;
		const existing = await this.retrieve(userId);
		if (existing !== undefined && this.isActiveSuperuser(existing)) {
			throw new LastActiveSuperuserError();
		}
		return undefined;
	}

	/**
	 * Replaces the user's whole permission set with a single UPDATE (and touches
	 * `updatedAt`). The single-statement replacement keeps a permission-set
	 * change atomic: no reader can observe a half-applied set. A missing user is
	 * a no-op.
	 */
	async setUserPermissions(userId: string, permissions: readonly string[]): Promise<void> {
		await this.db
			.update(this.table)
			.set({
				permissions: JSON.stringify(permissions),
				updatedAt: Date.now(),
			} as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, userId));
	}

	/**
	 * Returns the user's stored permission set as a string array (via
	 * `parseStoredPermissions`, so malformed storage yields `[]` rather than
	 * throwing). Returns `[]` when the user does not exist.
	 */
	async userPermissions(userId: string): Promise<string[]> {
		const [row] = await this.db
			.select({ permissions: this.table.permissions })
			.from(this.table)
			.where(eq(this.table.id, userId))
			.limit(1);
		if (row === undefined) return [];
		return parseStoredPermissions(row.permissions);
	}

	/**
	 * Lists users ordered by username ascending. `query` matches `username` OR
	 * `label` with `LIKE '%query%' ESCAPE '\'` after escaping LIKE wildcards
	 * (same convention as the admin panel's search), so user input cannot widen
	 * the match scope. `limit` defaults to 50, `offset` to 0.
	 */
	async listUsers(
		options: SQLiteAdminAccountsListOptions = {},
	): Promise<SQLiteAdminUserRecord<TUsers>[]> {
		return this.db
			.select()
			.from(this.table)
			.where(this.searchCondition(options.query))
			.orderBy(asc(this.table.username))
			.limit(options.limit ?? DEFAULT_LIST_LIMIT)
			.offset(options.offset ?? 0);
	}

	/** Number of users matching `query` (same filter as `listUsers`; all users when omitted). */
	async count(query?: string): Promise<number> {
		const [row] = await this.db
			.select({ value: countRows() })
			.from(this.table)
			.where(this.searchCondition(query));
		return row?.value ?? 0;
	}

	/**
	 * Number of users that are both superusers and active. Consumers use this
	 * for last-superuser protection (refusing to deactivate, demote, or delete
	 * the only remaining active superuser).
	 */
	async countActiveSuperusers(): Promise<number> {
		const [row] = await this.db
			.select({ value: countRows() })
			.from(this.table)
			.where(and(eq(this.table.isSuperuser, true), eq(this.table.isActive, true)));
		return row?.value ?? 0;
	}

	/**
	 * Deletes the given user. A missing user is a no-op.
	 *
	 * When `options.protectLastActiveSuperuser` is `true`, the same guarded
	 * `WHERE` as `updateUser` is folded into the DELETE, so "is this the last
	 * active superuser" and the delete happen in one statement. If the guarded
	 * DELETE matches zero rows, a follow-up `retrieve` distinguishes the two
	 * reasons: the row still exists and is still an active superuser (throws
	 * `LastActiveSuperuserError`), or there was nothing to delete in the first
	 * place (silent no-op, same as the unguarded path).
	 */
	async deleteUser(userId: string, options: SQLiteAdminAccountsGuardOptions = {}): Promise<void> {
		const guarded = options.protectLastActiveSuperuser === true;
		const where = guarded
			? and(eq(this.table.id, userId), this.lastActiveSuperuserGuardCondition())
			: eq(this.table.id, userId);
		const [row] = await this.db.delete(this.table).where(where).returning();
		if (row !== undefined || !guarded) return;
		const existing = await this.retrieve(userId);
		if (existing !== undefined && this.isActiveSuperuser(existing)) {
			throw new LastActiveSuperuserError();
		}
	}

	/**
	 * Reads the contract-guaranteed base columns off a row of the generic table.
	 * `TUsers["$inferSelect"]` is opaque at the generic level (TypeScript cannot
	 * derive per-field types from the `AnySQLiteColumn` intersection), but every
	 * table satisfying `SQLiteAdminUserRecordTable` structurally carries these
	 * columns with exactly these data types, so `as` is used only here (same
	 * justification style as `SQLiteModel#paginate`).
	 */
	private baseRow(row: SQLiteAdminUserRecord<TUsers>): AdminUserBaseRow {
		return row as AdminUserBaseRow;
	}

	/**
	 * Reads `failedAttempts`/`lockedUntil` off a row of the generic table, for
	 * the same reason and with the same `as` justification as `baseRow`. Only
	 * called from `authenticate` after `this.lockoutColumns` has already
	 * confirmed the table carries these columns.
	 */
	private lockoutBaseRow(row: SQLiteAdminUserRecord<TUsers>): AdminUserLockoutBaseRow {
		return row as AdminUserLockoutBaseRow;
	}

	/** Whether the given row is currently both a superuser and active. */
	private isActiveSuperuser(row: SQLiteAdminUserRecord<TUsers>): boolean {
		const base = this.baseRow(row);
		return base.isSuperuser && base.isActive;
	}

	/**
	 * Records one failed login attempt as a single atomic UPDATE:
	 * `failedAttempts` is incremented, and `lockedUntil` is set to
	 * `Date.now() + lockDurationSeconds * 1000` only when the incremented count
	 * reaches `maxAttempts` (otherwise it is left as-is via the `CASE WHEN` —
	 * SQL, not a read-then-write, so a concurrent request cannot race past the
	 * threshold check). Called from `authenticate` for a wrong password on an
	 * unlocked account.
	 */
	private async recordFailedAttempt(
		lockoutTable: TUsers & SQLiteAdminUserLockoutRecordTable,
		lockout: SQLiteAdminAccountsLockoutOptions,
		userId: string,
	): Promise<void> {
		const lockedUntilOnThreshold = Date.now() + lockout.lockDurationSeconds * 1000;
		/** `Record<string, unknown>` + `as`, same convention as `createUser`'s `values`. */
		const update: Record<string, unknown> = {
			failedAttempts: sql`${lockoutTable.failedAttempts} + 1`,
			lockedUntil: sql`case when ${lockoutTable.failedAttempts} + 1 >= ${lockout.maxAttempts} then ${lockedUntilOnThreshold} else ${lockoutTable.lockedUntil} end`,
		};
		await this.db
			.update(this.table)
			.set(update as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, userId));
	}

	/**
	 * The `WHERE` fragment `updateUser`/`deleteUser` AND together with
	 * `eq(id, userId)` when `protectLastActiveSuperuser` is requested: the
	 * targeted row is allowed through when it is not currently an active
	 * superuser (`isSuperuser = false` or `isActive = false`), or when more
	 * than one active superuser exists besides it. Because this is combined
	 * into the same UPDATE/DELETE statement rather than checked beforehand,
	 * the check and the write are atomic — no concurrent request can slip
	 * between reading the count and applying the change.
	 */
	private lastActiveSuperuserGuardCondition(): SQL {
		return sql`(${eq(this.table.isSuperuser, false)} or ${eq(this.table.isActive, false)} or (select count(*) from ${this.table} where ${this.table.isSuperuser} and ${this.table.isActive}) > 1)`;
	}

	/** Hashes a password, forwarding the `iterations` option only when it was provided. */
	private hash(password: string): Promise<string> {
		return this.iterations === undefined
			? hashPassword(password)
			: hashPassword(password, { iterations: this.iterations });
	}

	/** Validates password length against `minPasswordLength` and `MAX_PASSWORD_LENGTH`, throwing a clear message. */
	private assertValidPassword(password: string): void {
		if (password.length < this.minPasswordLength) {
			throw new Error(
				`SQLiteAdminAccounts: password must be at least ${this.minPasswordLength} characters`,
			);
		}
		if (password.length > MAX_PASSWORD_LENGTH) {
			throw new Error(
				`SQLiteAdminAccounts: password must be at most ${MAX_PASSWORD_LENGTH} characters`,
			);
		}
	}

	/**
	 * Builds the `username OR label` LIKE condition for `listUsers`/`count`.
	 * Returns `undefined` (no filter) when `query` is unspecified or empty.
	 * drizzle-orm's `like` helper does not emit an ESCAPE clause, so the `sql`
	 * tag adds `ESCAPE '\'` explicitly (same reasoning as
	 * `AdminResource#searchWhere`).
	 */
	private searchCondition(query: string | undefined): SQL | undefined {
		if (query === undefined || query === "") return undefined;
		const pattern = `%${escapeLikePattern(query)}%`;
		return or(
			sql`${this.table.username} like ${pattern} escape '\\'`,
			sql`${this.table.label} like ${pattern} escape '\\'`,
		);
	}
}

/**
 * Returns a fresh record of the column builders for the default admin users
 * table. Fresh on every call, so apps can spread it into their own extended
 * table — this is the supported extension recipe:
 *
 * ```ts
 * export const adminOperators = sqliteTable(
 *   "admin_operators",
 *   {
 *     ...sqliteAdminUserColumns(),
 *     email: text("email").notNull(),
 *   },
 *   (t) => [uniqueIndex("admin_operators_username_idx").on(t.username)],
 * );
 * ```
 *
 * The extended table still satisfies `SQLiteAdminUserRecordTable`, and
 * `SQLiteAdminAccounts` types the extra columns on `createUser`/`updateUser`
 * input and on returned rows. Keep the UNIQUE index on `username` — uniqueness
 * (and `createUser`'s duplicate handling) depends on it.
 */
export const sqliteAdminUserColumns = () => ({
	id: text("id").primaryKey(),
	username: text("username").notNull(),
	passwordHash: text("password_hash").notNull(),
	label: text("label"),
	isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
	isSuperuser: integer("is_superuser", { mode: "boolean" }).notNull().default(false),
	permissions: text("permissions").notNull().default("[]"),
	lastLoginAt: integer("last_login_at"),
	createdAt: integer("created_at").notNull(),
	updatedAt: integer("updated_at").notNull(),
});

/**
 * Factory that returns a default schema satisfying `SQLiteAdminUserRecordTable`.
 * The table name can be changed via the `tableName` argument (defaults to
 * `"admin_users"`). Migration generation is left to the app via drizzle-kit
 * (this factory only provides the schema definition).
 */
export const sqliteAdminUsersTable = (tableName = "admin_users") =>
	sqliteTable(tableName, sqliteAdminUserColumns(), (t) => [
		/** Uniqueness of the (normalized) username; `createUser`'s pre-check is advisory, this index is authoritative. */
		uniqueIndex(`${tableName}_username_idx`).on(t.username),
	]) satisfies SQLiteAdminUserRecordTable;

/**
 * Returns a fresh record of the column builders for the opt-in lockout
 * columns. Spread alongside `sqliteAdminUserColumns()` into the same table to
 * enable `SQLiteAdminAccountsOptions#lockout`:
 *
 * ```ts
 * export const adminUsers = sqliteTable(
 *   "admin_users",
 *   { ...sqliteAdminUserColumns(), ...sqliteAdminUserLockoutColumns() },
 *   (t) => [uniqueIndex("admin_users_username_idx").on(t.username)],
 * );
 * ```
 *
 * `failedAttempts` counts consecutive failed logins (defaults to 0);
 * `lockedUntil` is `null` while unlocked and an epoch-ms timestamp while
 * locked. Both are reserved columns (see `ReservedAdminUserColumnKey`) — only
 * `SQLiteAdminAccounts#authenticate` and `#unlockUser` ever write them. See
 * `authenticate`'s JSDoc for the algorithm.
 */
export const sqliteAdminUserLockoutColumns = () => ({
	failedAttempts: integer("failed_attempts").notNull().default(0),
	lockedUntil: integer("locked_until"),
});
