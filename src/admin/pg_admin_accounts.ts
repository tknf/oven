/**
 * Postgres (pg-core) implementation of admin-panel operator accounts: a users
 * table (id, username, password hash, active/superuser flags, a JSON permission
 * set, timestamps) plus a service class (`PgAdminAccounts`) for creating,
 * authenticating, and managing those users. It parallel-implements the same
 * contract (column contract, algorithm, JSDoc structure) as
 * `SQLiteAdminAccounts` in `sqlite_admin_accounts.ts` for pg-core
 * (dialect-specific parallel implementation; see the module JSDoc of
 * `pg_model.ts`). See `sqlite_admin_accounts.ts` for the canonical description
 * of username normalization, password bounds, and the extension recipe; only
 * the Postgres-specific decisions are documented here.
 *
 * Injecting an arbitrary table over Drizzle (pg-core) follows the same
 * convention as `PgAuditLog` in `audit/pg_audit_log.ts` (accepting a column
 * contract, typing via `AnyPgColumn`, constructor injection of db/table).
 *
 * Postgres-specific column decisions: `lastLoginAt`/`createdAt`/`updatedAt`
 * store epoch ms and use `bigint(..., { mode: "number" })` because a 32-bit
 * `integer` would go out of range (same reason as `createdAt`/`updatedAt` in
 * `pg_model.ts`), and the flags use the native `boolean()` column type.
 * pg-core supports `.returning()`, so the write paths are identical to the
 * SQLite version. The one behavioral divergence is `listUsers`/`count` search:
 * Postgres `LIKE` is case-sensitive (see `searchCondition`).
 *
 * The type of `db` is `PgDatabase<TQueryResult, TSchema>` (see the module JSDoc
 * of `pg_model.ts` for why `TQueryResult` is promoted to a class type
 * parameter), and `TSchema` is generic for the same reason as `SQLiteAdminAccounts`.
 */
import { and, asc, count as countRows, eq, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { bigint, boolean, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import type {
	AnyPgColumn,
	PgDatabase,
	PgQueryResultHKT,
	PgTable,
	TableConfig,
} from "drizzle-orm/pg-core";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { LastActiveSuperuserError } from "./admin_accounts_errors.js";
import { parseStoredPermissions } from "./admin_permissions.js";

/** Default lower bound on password length (overridable via `PgAdminAccountsOptions#minPasswordLength`). */
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
 * JSDoc of `sqlite_admin_accounts.ts` for the cross-dialect rationale.
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
 * The type of a Drizzle table with the columns required by `PgAdminAccounts`.
 * Uses `AnyPgColumn` (the same idea as `PgAuditRecordTable`) and does not care
 * about the table name or other column layout, so a table extended with
 * app-specific columns still satisfies it.
 */
export type PgAdminUserRecordTable = PgTable<TableConfig> & {
	id: AnyPgColumn<{ data: string; notNull: true }>;
	username: AnyPgColumn<{ data: string; notNull: true }>;
	passwordHash: AnyPgColumn<{ data: string; notNull: true }>;
	label: AnyPgColumn<{ data: string; notNull: false }>;
	isActive: AnyPgColumn<{ data: boolean; notNull: true }>;
	isSuperuser: AnyPgColumn<{ data: boolean; notNull: true }>;
	permissions: AnyPgColumn<{ data: string; notNull: true }>;
	lastLoginAt: AnyPgColumn<{ data: number; notNull: false }>;
	createdAt: AnyPgColumn<{ data: number; notNull: true }>;
	updatedAt: AnyPgColumn<{ data: number; notNull: true }>;
};

/**
 * Row type of a table satisfying `PgAdminUserRecordTable`, derived from
 * `$inferSelect` (same technique as `PgModelRecord` in `model/pg_model.ts`).
 * For an extended table this includes the app's extra columns.
 */
export type PgAdminUserRecord<TUsers extends PgAdminUserRecordTable> = TUsers["$inferSelect"];

/**
 * Column keys owned and managed by `PgAdminAccounts`. They are excluded from
 * the extra-column input type (`PgAdminUserExtraInput`) and stripped from extra
 * input at runtime, so callers can never smuggle e.g. a `passwordHash` through
 * the extension mechanism.
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
	| "updatedAt";

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
] satisfies ReservedAdminUserColumnKey[]);

/**
 * The app-specific extra columns of an extended table, as insert input. For the
 * plain `pgAdminUsersTable()` table this resolves to an empty object; for an
 * extended table the app's extra NOT NULL columns become required on
 * `createUser` (and optional on `updateUser`).
 */
export type PgAdminUserExtraInput<TUsers extends PgAdminUserRecordTable> = Omit<
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
 * Copies extra-column input into a fresh record, dropping any reserved key.
 * The type level already excludes reserved keys (`PgAdminUserExtraInput`), so
 * this is a runtime backstop for callers that bypass the types.
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

/** Options for constructing a `PgAdminAccounts`. */
export type PgAdminAccountsOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `PgModel`). */
	idGenerator?: IdGenerator;
	/** PBKDF2 iteration count forwarded to `hashPassword`. When omitted, `hashPassword`'s own default applies. */
	iterations?: number;
	/** Minimum accepted password length. Defaults to 8. The hard maximum is always 1024 (see `MAX_PASSWORD_LENGTH`). */
	minPasswordLength?: number;
};

/** Input for `PgAdminAccounts#createUser` (plus the extended table's extra columns, when present). */
export type PgAdminAccountsCreateUserInput<TUsers extends PgAdminUserRecordTable> = {
	username: string;
	password: string;
	label?: string | null;
	isActive?: boolean;
	isSuperuser?: boolean;
	permissions?: readonly string[];
} & PgAdminUserExtraInput<TUsers>;

/** Patch for `PgAdminAccounts#updateUser` (plus the extended table's extra columns, when present). */
export type PgAdminAccountsUpdateUserPatch<TUsers extends PgAdminUserRecordTable> = {
	username?: string;
	label?: string | null;
	isActive?: boolean;
	isSuperuser?: boolean;
} & Partial<PgAdminUserExtraInput<TUsers>>;

/** Options accepted by `PgAdminAccounts#updateUser` and `#deleteUser`. */
export type PgAdminAccountsGuardOptions = {
	/**
	 * When `true`, refuses (throwing `LastActiveSuperuserError`) to apply a
	 * change that would leave zero active superusers. See `updateUser`/
	 * `deleteUser` for how the guard is enforced.
	 */
	protectLastActiveSuperuser?: boolean;
};

/** Query options for `PgAdminAccounts#listUsers`. */
export type PgAdminAccountsListOptions = {
	/** Matches `username` OR `label` with an escaped `LIKE '%query%'` (see `listUsers`). */
	query?: string;
	/** Maximum number of rows to return. Defaults to 50. */
	limit?: number;
	/** Number of rows to skip. Defaults to 0. */
	offset?: number;
};

/**
 * Operator-account service backed by a Drizzle pg-core table satisfying
 * `PgAdminUserRecordTable`. Generic over the concrete table so extended tables
 * keep their extra columns typed on inputs and returned rows.
 */
export class PgAdminAccounts<
	TUsers extends PgAdminUserRecordTable,
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly idGenerator: IdGenerator;
	private readonly iterations: number | undefined;
	private readonly minPasswordLength: number;

	constructor(
		private readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly table: TUsers,
		options: PgAdminAccountsOptions = {},
	) {
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
		this.iterations = options.iterations;
		this.minPasswordLength = options.minPasswordLength ?? DEFAULT_MIN_PASSWORD_LENGTH;
	}

	/**
	 * Internal helper for referring to `this.table` as `PgTable` (the concrete
	 * type with the `TUsers` type parameter erased). pg-core's `.from()`/
	 * `.insert()`/`.update()`/`.delete()` have overloads keyed on conditional
	 * types that cannot resolve for an abstract type parameter and cause a
	 * compile error (same pg-core-specific issue and workaround as
	 * `PgModel#pgTable`; see its JSDoc in `model/pg_model.ts`). Every Drizzle
	 * verb call site uses this getter instead of `this.table` directly (column
	 * references keep using `this.table`).
	 */
	private get pgTable(): PgTable {
		return this.table;
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
		input: PgAdminAccountsCreateUserInput<TUsers>,
	): Promise<PgAdminUserRecord<TUsers>> {
		const { username, password, label, isActive, isSuperuser, permissions, ...extras } = input;
		const normalized = normalizeUsername(username);
		if (normalized === "") {
			throw new Error("PgAdminAccounts#createUser: username must not be empty");
		}
		this.assertValidPassword(password);
		const existing = await this.findByUsername(normalized);
		if (existing !== undefined) {
			throw new Error(`PgAdminAccounts#createUser: username "${normalized}" is already taken`);
		}
		const passwordHash = await this.hash(password);
		const now = Date.now();
		/**
		 * Reserved columns are written after the sanitized extras so they can
		 * never be overridden. Because the extra columns vary per table,
		 * TypeScript cannot statically relate this record to the generic
		 * `$inferInsert`, so `as` is used only when passing to `values` (same
		 * justification as `SQLiteAdminAccounts#createUser`).
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
			.insert(this.pgTable)
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
	 * `isActive` check, so an inactive account costs the same as an active one.
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
	 */
	async authenticate(credentials: {
		username: string;
		password: string;
	}): Promise<PgAdminUserRecord<TUsers> | null> {
		if (credentials.password.length > MAX_PASSWORD_LENGTH) return null;
		const row = await this.findByUsername(credentials.username);
		if (row === undefined) {
			await verifyPassword(credentials.password, DUMMY_PASSWORD_HASH);
			return null;
		}
		const base = this.baseRow(row);
		const matched = await verifyPassword(credentials.password, base.passwordHash);
		if (!matched) return null;
		if (!base.isActive) return null;
		const lastLoginAt = Date.now();
		await this.db
			.update(this.pgTable)
			.set({ lastLoginAt } as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, base.id));
		/**
		 * Spreading the generic row loses its identity with `$inferSelect` at the
		 * type level even though only `lastLoginAt` (a contract column) changes,
		 * so `as` is used only here.
		 */
		return { ...row, lastLoginAt } as PgAdminUserRecord<TUsers>;
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
			.update(this.pgTable)
			.set({ passwordHash, updatedAt: Date.now() } as Partial<TUsers["$inferInsert"]>)
			.where(eq(this.table.id, userId));
	}

	/** Fetches a single user by id. Returns `undefined` if it doesn't exist. */
	async retrieve(userId: string): Promise<PgAdminUserRecord<TUsers> | undefined> {
		const [row] = await this.db
			.select()
			.from(this.pgTable)
			.where(eq(this.table.id, userId))
			.limit(1);
		return row;
	}

	/** Fetches a single user by username (normalized before lookup). Returns `undefined` if it doesn't exist. */
	async findByUsername(username: string): Promise<PgAdminUserRecord<TUsers> | undefined> {
		const normalized = normalizeUsername(username);
		const [row] = await this.db
			.select()
			.from(this.pgTable)
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
		patch: PgAdminAccountsUpdateUserPatch<TUsers>,
		options: PgAdminAccountsGuardOptions = {},
	): Promise<PgAdminUserRecord<TUsers> | undefined> {
		const { username, label, isActive, isSuperuser, ...extras } = patch;
		const update: Record<string, unknown> = sanitizeExtraColumns(extras);
		if (username !== undefined) {
			const normalized = normalizeUsername(username);
			if (normalized === "") {
				throw new Error("PgAdminAccounts#updateUser: username must not be empty");
			}
			const existing = await this.findByUsername(normalized);
			if (existing !== undefined && this.baseRow(existing).id !== userId) {
				throw new Error(`PgAdminAccounts#updateUser: username "${normalized}" is already taken`);
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
			.update(this.pgTable)
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
			.update(this.pgTable)
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
			.from(this.pgTable)
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
	 *
	 * Dialect divergence: Postgres `LIKE` is case-sensitive, while SQLite's is
	 * ASCII-case-insensitive. `LIKE` is kept (rather than switching to `ILIKE`)
	 * so the SQL semantics stay parallel across dialects; usernames are stored
	 * lowercase, so only `label` matching (and non-lowercase queries) differ.
	 */
	async listUsers(options: PgAdminAccountsListOptions = {}): Promise<PgAdminUserRecord<TUsers>[]> {
		return this.db
			.select()
			.from(this.pgTable)
			.where(this.searchCondition(options.query))
			.orderBy(asc(this.table.username))
			.limit(options.limit ?? DEFAULT_LIST_LIMIT)
			.offset(options.offset ?? 0);
	}

	/** Number of users matching `query` (same filter as `listUsers`, including its case-sensitivity divergence; all users when omitted). */
	async count(query?: string): Promise<number> {
		const [row] = await this.db
			.select({ value: countRows() })
			.from(this.pgTable)
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
			.from(this.pgTable)
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
	async deleteUser(userId: string, options: PgAdminAccountsGuardOptions = {}): Promise<void> {
		const guarded = options.protectLastActiveSuperuser === true;
		const where = guarded
			? and(eq(this.table.id, userId), this.lastActiveSuperuserGuardCondition())
			: eq(this.table.id, userId);
		const [row] = await this.db.delete(this.pgTable).where(where).returning();
		if (row !== undefined || !guarded) return;
		const existing = await this.retrieve(userId);
		if (existing !== undefined && this.isActiveSuperuser(existing)) {
			throw new LastActiveSuperuserError();
		}
	}

	/**
	 * Reads the contract-guaranteed base columns off a row of the generic table.
	 * `TUsers["$inferSelect"]` is opaque at the generic level (TypeScript cannot
	 * derive per-field types from the `AnyPgColumn` intersection), but every
	 * table satisfying `PgAdminUserRecordTable` structurally carries these
	 * columns with exactly these data types, so `as` is used only here (same
	 * justification style as `SQLiteAdminAccounts#baseRow`).
	 */
	private baseRow(row: PgAdminUserRecord<TUsers>): AdminUserBaseRow {
		return row as AdminUserBaseRow;
	}

	/** Whether the given row is currently both a superuser and active. */
	private isActiveSuperuser(row: PgAdminUserRecord<TUsers>): boolean {
		const base = this.baseRow(row);
		return base.isSuperuser && base.isActive;
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
				`PgAdminAccounts: password must be at least ${this.minPasswordLength} characters`,
			);
		}
		if (password.length > MAX_PASSWORD_LENGTH) {
			throw new Error(
				`PgAdminAccounts: password must be at most ${MAX_PASSWORD_LENGTH} characters`,
			);
		}
	}

	/**
	 * Builds the `username OR label` LIKE condition for `listUsers`/`count`.
	 * Returns `undefined` (no filter) when `query` is unspecified or empty.
	 * drizzle-orm's `like` helper does not emit an ESCAPE clause, so the `sql`
	 * tag adds `ESCAPE '\'` explicitly (Postgres's `standard_conforming_strings`
	 * default parses `'\'` as a single backslash). Matching is case-sensitive on
	 * Postgres (see `listUsers`'s JSDoc for the documented divergence).
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
 * export const adminOperators = pgTable(
 *   "admin_operators",
 *   {
 *     ...pgAdminUserColumns(),
 *     email: text("email").notNull(),
 *   },
 *   (t) => [uniqueIndex("admin_operators_username_idx").on(t.username)],
 * );
 * ```
 *
 * The extended table still satisfies `PgAdminUserRecordTable`, and
 * `PgAdminAccounts` types the extra columns on `createUser`/`updateUser` input
 * and on returned rows. Keep the UNIQUE index on `username` — uniqueness (and
 * `createUser`'s duplicate handling) depends on it.
 */
export const pgAdminUserColumns = () => ({
	id: text("id").primaryKey(),
	username: text("username").notNull(),
	passwordHash: text("password_hash").notNull(),
	label: text("label"),
	isActive: boolean("is_active").notNull().default(true),
	isSuperuser: boolean("is_superuser").notNull().default(false),
	permissions: text("permissions").notNull().default("[]"),
	lastLoginAt: bigint("last_login_at", { mode: "number" }),
	createdAt: bigint("created_at", { mode: "number" }).notNull(),
	updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

/**
 * Factory that returns a default schema satisfying `PgAdminUserRecordTable`.
 * The table name can be changed via the `tableName` argument (defaults to
 * `"admin_users"`). Migration generation is left to the app via drizzle-kit
 * (this factory only provides the schema definition).
 */
export const pgAdminUsersTable = (tableName = "admin_users") =>
	pgTable(tableName, pgAdminUserColumns(), (t) => [
		/** Uniqueness of the (normalized) username; `createUser`'s pre-check is advisory, this index is authoritative. */
		uniqueIndex(`${tableName}_username_idx`).on(t.username),
	]) satisfies PgAdminUserRecordTable;
