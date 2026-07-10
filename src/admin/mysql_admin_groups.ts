/**
 * MySQL (mysql-core) implementation of admin-panel operator groups: a groups
 * table (id, unique name, a JSON permission set, timestamps), a membership
 * table (userId/groupId pairs), and a service class (`MySqlAdminGroups`) for
 * creating groups, managing memberships, and resolving group-based
 * permissions. It parallel-implements the same contract (column contracts,
 * algorithm, JSDoc structure) as `SQLiteAdminGroups` in
 * `sqlite_admin_groups.ts` for mysql-core (dialect-specific parallel
 * implementation; see the module JSDoc of `mysql_model.ts`). See
 * `sqlite_admin_groups.ts` for the canonical description of group-name
 * normalization (trim only, never lowercased), the fail-closed write ordering
 * of `deleteGroup`/`setUserGroups`, and the no-foreign-keys decision; only the
 * MySQL-specific decisions are documented here.
 *
 * MySQL-specific column decisions: `id`/`name` (and the membership table's
 * `userId`/`groupId`) use `varchar(255)` because a TEXT column cannot back a
 * PRIMARY KEY or UNIQUE index without a key-length prefix (same reasoning as
 * `mysqlAdminUsersTable`); `createdAt`/`updatedAt` store epoch ms and use
 * `bigint(..., { mode: "number" })` because a 32-bit `int` would go out of
 * range (same reason as `createdAt`/`updatedAt` in `mysql_model.ts`); and
 * `permissions` has no DEFAULT clause (see `mysqlAdminGroupsTable`).
 *
 * Dialect divergence: group names are only trimmed, never lowercased, and
 * MySQL compares strings by the column collation — with the default
 * accent/case-insensitive `utf8mb4` collations, names differing only in case
 * collide (both in `findByName`'s pre-check and at the UNIQUE index), while
 * SQLite and Postgres treat them as distinct groups. Usernames avoid this by
 * lowercasing (see `sqlite_admin_accounts.ts`); group names deliberately do
 * not, because a group name is a display label whose case is worth
 * preserving.
 *
 * MySQL doesn't support INSERT/UPDATE ... RETURNING, so `createGroup` and
 * `updateGroup` re-SELECT the row by its already-known id after the write
 * (the same non-atomic approximation as `MySqlAdminAccounts#createUser`; see
 * the module JSDoc of `mysql_model.ts`, "Working around the lack of RETURNING
 * support"). All return values keep the same semantics as the SQLite version
 * from the caller's perspective.
 *
 * The type of `db` is `MySqlDatabase<TQueryResult, TPreparedQueryHKT,
 * TSchema>` (see the module JSDoc of `mysql_model.ts` for why both are
 * promoted to class type parameters), and `TSchema` is generic for the same
 * reason as `SQLiteAdminGroups`.
 */
import { asc, eq, getTableColumns } from "drizzle-orm";
import {
	bigint,
	index,
	mysqlTable,
	primaryKey,
	text,
	uniqueIndex,
	varchar,
} from "drizzle-orm/mysql-core";
import type {
	AnyMySqlColumn,
	MySqlDatabase,
	MySqlQueryResultHKT,
	MySqlTable,
	PreparedQueryHKTBase,
	TableConfig,
} from "drizzle-orm/mysql-core";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { parseStoredPermissions } from "./admin_permissions.js";

/**
 * Normalizes a group name (trim only — group names are NOT lowercased, unlike
 * usernames; see the module JSDoc of `sqlite_admin_groups.ts` for the
 * asymmetry). Applied at the service boundary in
 * `createGroup`/`updateGroup`/`findByName`.
 */
const normalizeGroupName = (name: string): string => name.trim();

/**
 * The type of a Drizzle table with the columns required by `MySqlAdminGroups`
 * for the groups table. Uses `AnyMySqlColumn` (the same idea as
 * `MySqlAdminUserRecordTable`) and does not care about the table name or
 * other column layout, so a table extended with app-specific columns still
 * satisfies it.
 */
export type MySqlAdminGroupRecordTable = MySqlTable<TableConfig> & {
	id: AnyMySqlColumn<{ data: string; notNull: true }>;
	name: AnyMySqlColumn<{ data: string; notNull: true }>;
	permissions: AnyMySqlColumn<{ data: string; notNull: true }>;
	createdAt: AnyMySqlColumn<{ data: number; notNull: true }>;
	updatedAt: AnyMySqlColumn<{ data: number; notNull: true }>;
};

/**
 * The type of a Drizzle table with the columns required by `MySqlAdminGroups`
 * for the membership table (one row per user/group pair).
 */
export type MySqlAdminUserGroupRecordTable = MySqlTable<TableConfig> & {
	userId: AnyMySqlColumn<{ data: string; notNull: true }>;
	groupId: AnyMySqlColumn<{ data: string; notNull: true }>;
	createdAt: AnyMySqlColumn<{ data: number; notNull: true }>;
};

/**
 * Row type of a table satisfying `MySqlAdminGroupRecordTable`, derived from
 * `$inferSelect` (same technique as `MySqlAdminUserRecord`).
 */
export type MySqlAdminGroupRecord<TGroups extends MySqlAdminGroupRecordTable> =
	TGroups["$inferSelect"];

/**
 * The contract-guaranteed base columns of a group row, with their concrete
 * data types. Used internally to read fields off rows of the generic table
 * (see `baseRow`).
 */
type AdminGroupBaseRow = {
	id: string;
	name: string;
	permissions: string;
	createdAt: number;
	updatedAt: number;
};

/** Options for constructing a `MySqlAdminGroups`. */
export type MySqlAdminGroupsOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `MySqlAdminAccounts`). */
	idGenerator?: IdGenerator;
};

/**
 * Operator-group service backed by two Drizzle mysql-core tables: a groups
 * table satisfying `MySqlAdminGroupRecordTable` and a membership table
 * satisfying `MySqlAdminUserGroupRecordTable`. Both tables are required —
 * feature presence is expressed at the type level by constructing the class,
 * never by optional tables. Generic over the concrete tables so an extended
 * groups table keeps its extra columns typed on returned rows.
 */
export class MySqlAdminGroups<
	TGroups extends MySqlAdminGroupRecordTable,
	TUserGroups extends MySqlAdminUserGroupRecordTable,
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly idGenerator: IdGenerator;
	private readonly groups: TGroups;
	/** Named `members` (not `userGroups`) so the field does not collide with the `userGroups` method. */
	private readonly members: TUserGroups;

	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>,
		tables: { groups: TGroups; userGroups: TUserGroups },
		options: MySqlAdminGroupsOptions = {},
	) {
		this.groups = tables.groups;
		this.members = tables.userGroups;
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * Internal helpers for referring to the injected tables as `MySqlTable`
	 * (the concrete type with the generic type parameter erased). The JOIN
	 * query builder's result-type bookkeeping (`AppendToResult`) cannot resolve
	 * for an abstract type parameter and rejects further chaining, so every
	 * JOIN call site uses these getters (the same erase-at-the-verb workaround
	 * as `SQLiteAdminGroups#sqliteGroupsTable`); non-JOIN verbs keep using the
	 * generic tables directly, and column references always do.
	 */
	private get mysqlGroupsTable(): MySqlTable {
		return this.groups;
	}

	/** See `mysqlGroupsTable`. */
	private get mysqlUserGroupsTable(): MySqlTable {
		return this.members;
	}

	/**
	 * Creates a group. The name is trimmed (NOT lowercased — see the module
	 * JSDoc of `sqlite_admin_groups.ts`) and must not be empty. A duplicate
	 * name is pre-checked via `findByName` and throws (note the collation
	 * divergence in the module JSDoc: on MySQL's default collations, names
	 * differing only in case count as duplicates); the table's UNIQUE index is
	 * the last line of defense, so a concurrent insert racing past the
	 * pre-check surfaces as a raw driver error. `permissions` defaults to `[]`
	 * (always written explicitly — the column has no DEFAULT clause, see
	 * `mysqlAdminGroupsTable`). Returns the created row. Since MySQL doesn't
	 * support RETURNING, the row is fetched back by re-SELECTing on the
	 * already-generated id after the write (see the module JSDoc of
	 * `mysql_model.ts`, "Working around the lack of RETURNING support"; note
	 * this is non-atomic).
	 */
	async createGroup(input: {
		name: string;
		permissions?: readonly string[];
	}): Promise<MySqlAdminGroupRecord<TGroups>> {
		const name = normalizeGroupName(input.name);
		if (name === "") {
			throw new Error("MySqlAdminGroups#createGroup: group name must not be empty");
		}
		const existing = await this.findByName(name);
		if (existing !== undefined) {
			throw new Error(`MySqlAdminGroups#createGroup: group name "${name}" is already taken`);
		}
		const now = Date.now();
		const id = this.idGenerator.generate();
		const values = {
			id,
			name,
			permissions: JSON.stringify(input.permissions ?? []),
			createdAt: now,
			updatedAt: now,
		};
		/**
		 * TypeScript cannot statically relate this record to the generic
		 * `$inferInsert` (`TGroups` is opaque at the generic level), so `as` is
		 * used only when passing to `values` (same justification as
		 * `MySqlAdminAccounts#createUser`).
		 */
		await this.db.insert(this.groups).values(values as TGroups["$inferInsert"]);
		const row = await this.retrieve(id);
		if (row === undefined) {
			throw new Error(
				"MySqlAdminGroups#createGroup: could not find the row on the post-write re-SELECT.",
			);
		}
		return row;
	}

	/**
	 * Renames the given group and touches `updatedAt`. A `name` in the patch is
	 * trimmed and duplicate-pre-checked (excluding this group's own row; the
	 * collation divergence in the module JSDoc applies here too).
	 * `permissions`/`id`/timestamps can never pass through this method;
	 * `setGroupPermissions` owns the permission set. Returns the updated row,
	 * or `undefined` when the group does not exist. Since MySQL doesn't support
	 * RETURNING, the row is fetched back by re-SELECTing on `groupId` after the
	 * write (see the module JSDoc of `mysql_model.ts`, "Working around the lack
	 * of RETURNING support"; note this is non-atomic).
	 */
	async updateGroup(
		groupId: string,
		patch: { name?: string },
	): Promise<MySqlAdminGroupRecord<TGroups> | undefined> {
		const update: Record<string, unknown> = {};
		if (patch.name !== undefined) {
			const name = normalizeGroupName(patch.name);
			if (name === "") {
				throw new Error("MySqlAdminGroups#updateGroup: group name must not be empty");
			}
			const existing = await this.findByName(name);
			if (existing !== undefined && this.baseRow(existing).id !== groupId) {
				throw new Error(`MySqlAdminGroups#updateGroup: group name "${name}" is already taken`);
			}
			update.name = name;
		}
		update.updatedAt = Date.now();
		/** `as` for the same generic-`$inferInsert` reason as `createGroup`. */
		await this.db
			.update(this.groups)
			.set(update as Partial<TGroups["$inferInsert"]>)
			.where(eq(this.groups.id, groupId));
		return this.retrieve(groupId);
	}

	/**
	 * Deletes the given group. Membership rows are deleted FIRST, then the
	 * group row: there is no cross-table transaction primitive in this repo
	 * (see the module JSDoc of `sqlite_admin_groups.ts`), so the order is
	 * chosen fail-closed — a failure between the two statements leaves a group
	 * without members rather than memberships pointing at a deleted group. A
	 * missing group is a no-op.
	 */
	async deleteGroup(groupId: string): Promise<void> {
		await this.db.delete(this.members).where(eq(this.members.groupId, groupId));
		await this.db.delete(this.groups).where(eq(this.groups.id, groupId));
	}

	/** Fetches a single group by id. Returns `undefined` if it doesn't exist. */
	async retrieve(groupId: string): Promise<MySqlAdminGroupRecord<TGroups> | undefined> {
		const [row] = await this.db
			.select()
			.from(this.groups)
			.where(eq(this.groups.id, groupId))
			.limit(1);
		return row;
	}

	/**
	 * Fetches a single group by name (trimmed before lookup, never lowercased).
	 * Returns `undefined` if it doesn't exist. Matching follows the column
	 * collation (see the module JSDoc): on MySQL's default collations a lookup
	 * differing only in case still matches.
	 */
	async findByName(name: string): Promise<MySqlAdminGroupRecord<TGroups> | undefined> {
		const normalized = normalizeGroupName(name);
		const [row] = await this.db
			.select()
			.from(this.groups)
			.where(eq(this.groups.name, normalized))
			.limit(1);
		return row;
	}

	/** Lists every group ordered by name ascending. */
	async listGroups(): Promise<MySqlAdminGroupRecord<TGroups>[]> {
		return this.db.select().from(this.groups).orderBy(asc(this.groups.name));
	}

	/**
	 * Replaces the group's whole permission set with a single UPDATE (and
	 * touches `updatedAt`). The single-statement replacement keeps a
	 * permission-set change atomic: no reader can observe a half-applied set
	 * (same reasoning as `MySqlAdminAccounts#setUserPermissions`). A missing
	 * group is a no-op.
	 */
	async setGroupPermissions(groupId: string, permissions: readonly string[]): Promise<void> {
		await this.db
			.update(this.groups)
			.set({
				permissions: JSON.stringify(permissions),
				updatedAt: Date.now(),
			} as Partial<TGroups["$inferInsert"]>)
			.where(eq(this.groups.id, groupId));
	}

	/**
	 * Returns the group's stored permission set as a string array (via
	 * `parseStoredPermissions`, so malformed storage yields `[]` rather than
	 * throwing). Returns `[]` when the group does not exist.
	 */
	async groupPermissions(groupId: string): Promise<string[]> {
		const [row] = await this.db
			.select({ permissions: this.groups.permissions })
			.from(this.groups)
			.where(eq(this.groups.id, groupId))
			.limit(1);
		if (row === undefined) return [];
		return parseStoredPermissions(row.permissions);
	}

	/**
	 * Replaces the user's memberships: DELETEs all of the user's membership
	 * rows, then INSERTs one row per (deduplicated) group id. The two
	 * statements are not transactional (see the module JSDoc of
	 * `sqlite_admin_groups.ts`) and are deliberately ordered so a mid-way
	 * failure leaves the user with FEWER groups (fail-closed for permissions),
	 * never stale extras — re-run this method on error. An empty array removes
	 * every membership. Group ids are NOT validated to exist: an unknown id
	 * produces a membership row that `userGroups`/`permissionsForUser` ignore
	 * (inner join).
	 */
	async setUserGroups(userId: string, groupIds: readonly string[]): Promise<void> {
		const deduped = [...new Set(groupIds)];
		await this.db.delete(this.members).where(eq(this.members.userId, userId));
		if (deduped.length === 0) return;
		const now = Date.now();
		const rows = deduped.map((groupId) => ({ userId, groupId, createdAt: now }));
		/** `as` for the same generic-`$inferInsert` reason as `createGroup`. */
		await this.db.insert(this.members).values(rows as TUserGroups["$inferInsert"][]);
	}

	/**
	 * Returns the groups the user belongs to, ordered by group name ascending,
	 * in one JOIN query (memberships ⨝ groups). Memberships whose group no
	 * longer exists are naturally absent (inner join).
	 */
	async userGroups(userId: string): Promise<MySqlAdminGroupRecord<TGroups>[]> {
		/**
		 * The selection spreads every column of the groups table
		 * (`getTableColumns`), so each result row is exactly a row of `TGroups`;
		 * the generic table's column map is opaque to TypeScript (same
		 * justification style as `baseRow`), so `as` is used only on the result.
		 */
		const rows = await this.db
			.select(getTableColumns(this.mysqlGroupsTable))
			.from(this.mysqlUserGroupsTable)
			.innerJoin(this.mysqlGroupsTable, eq(this.members.groupId, this.groups.id))
			.where(eq(this.members.userId, userId))
			.orderBy(asc(this.groups.name));
		return rows as MySqlAdminGroupRecord<TGroups>[];
	}

	/**
	 * Returns the user ids of the group's members, ordered ascending for
	 * determinism (the membership table's groupId index covers this reverse
	 * lookup). Ids of users deleted out-of-band still appear until their
	 * membership rows are cleaned up (`setUserGroups(userId, [])`).
	 */
	async groupMembers(groupId: string): Promise<string[]> {
		const rows = await this.db
			.select({ userId: this.members.userId })
			.from(this.members)
			.where(eq(this.members.groupId, groupId))
			.orderBy(asc(this.members.userId));
		return rows.map((row) => row.userId);
	}

	/**
	 * Resolves the union of the permission sets of every group the user belongs
	 * to, in one JOIN query. Groups are visited in name order (ascending) and
	 * the union deduplicates while preserving first-seen order, so the result
	 * is deterministic. Dangling memberships contribute nothing (inner join),
	 * and malformed storage in one group yields `[]` for that group only (via
	 * `parseStoredPermissions`). Consumers combine this with the user's own
	 * permission set (`MySqlAdminAccounts#userPermissions`); the superuser
	 * bypass lives with the consumer, not here.
	 */
	async permissionsForUser(userId: string): Promise<string[]> {
		const rows = await this.db
			.select({ permissions: this.groups.permissions })
			.from(this.mysqlUserGroupsTable)
			.innerJoin(this.mysqlGroupsTable, eq(this.members.groupId, this.groups.id))
			.where(eq(this.members.userId, userId))
			.orderBy(asc(this.groups.name));
		const union: string[] = [];
		const seen = new Set<string>();
		for (const row of rows) {
			for (const permission of parseStoredPermissions(row.permissions)) {
				if (!seen.has(permission)) {
					seen.add(permission);
					union.push(permission);
				}
			}
		}
		return union;
	}

	/**
	 * Reads the contract-guaranteed base columns off a row of the generic
	 * groups table. `TGroups["$inferSelect"]` is opaque at the generic level,
	 * but every table satisfying `MySqlAdminGroupRecordTable` structurally
	 * carries these columns with exactly these data types, so `as` is used
	 * only here (same justification style as `MySqlAdminAccounts#baseRow`).
	 */
	private baseRow(row: MySqlAdminGroupRecord<TGroups>): AdminGroupBaseRow {
		return row as AdminGroupBaseRow;
	}
}

/**
 * Factory that returns a default schema satisfying
 * `MySqlAdminGroupRecordTable`. The table name can be changed via the
 * `tableName` argument (defaults to `"admin_groups"`). Migration generation
 * is left to the app via drizzle-kit (this factory only provides the schema
 * definition). `id`/`name` are `varchar(255)` rather than TEXT because MySQL
 * cannot put a PRIMARY KEY or UNIQUE index on a TEXT column without a
 * key-length prefix (same reasoning as `mysqlAdminUsersTable`).
 */
export const mysqlAdminGroupsTable = (tableName = "admin_groups") =>
	mysqlTable(
		tableName,
		{
			id: varchar("id", { length: 255 }).primaryKey(),
			name: varchar("name", { length: 255 }).notNull(),
			/**
			 * No `.default("[]")` here: MySQL TEXT columns cannot have a DEFAULT
			 * clause. This is safe because `createGroup` always writes
			 * `permissions` explicitly.
			 */
			permissions: text("permissions").notNull(),
			createdAt: bigint("created_at", { mode: "number" }).notNull(),
			updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/** Uniqueness of the (trimmed) group name; `createGroup`'s pre-check is advisory, this index is authoritative. */
			uniqueIndex(`${tableName}_name_idx`).on(t.name),
		],
	) satisfies MySqlAdminGroupRecordTable;

/**
 * Factory that returns a default membership schema satisfying
 * `MySqlAdminUserGroupRecordTable`. The table name can be changed via the
 * `tableName` argument (defaults to `"admin_user_groups"`). No foreign-key
 * constraints are declared (see the module JSDoc of
 * `sqlite_admin_groups.ts`). `userId`/`groupId` are `varchar(255)` because
 * they back the composite PRIMARY KEY and the groupId index. Migration
 * generation is left to the app via drizzle-kit (this factory only provides
 * the schema definition).
 */
export const mysqlAdminUserGroupsTable = (tableName = "admin_user_groups") =>
	mysqlTable(
		tableName,
		{
			userId: varchar("user_id", { length: 255 }).notNull(),
			groupId: varchar("group_id", { length: 255 }).notNull(),
			createdAt: bigint("created_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/**
			 * The composite PK enforces one row per pair and covers
			 * userId-prefixed lookups (a user's memberships); the extra index
			 * covers the group-to-members reverse lookup.
			 */
			primaryKey({ columns: [t.userId, t.groupId] }),
			index(`${tableName}_group_id_idx`).on(t.groupId),
		],
	) satisfies MySqlAdminUserGroupRecordTable;
