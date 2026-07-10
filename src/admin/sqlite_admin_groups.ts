/**
 * SQLite (sqlite-core) implementation of admin-panel operator groups: a groups
 * table (id, unique name, a JSON permission set, timestamps), a membership
 * table (userId/groupId pairs), and a service class (`SQLiteAdminGroups`) for
 * creating groups, managing memberships, and resolving group-based
 * permissions. It complements the operator accounts in
 * `sqlite_admin_accounts.ts` (which owns the per-user permission set); the
 * permission-string vocabulary is shared (`admin_permissions.ts`).
 *
 * Injecting arbitrary tables over Drizzle (sqlite-core) follows the same
 * convention as `SQLiteAdminAccounts` (accepting column contracts, typing via
 * `AnySQLiteColumn`, constructor injection of db/tables). Per the
 * dialect-specific parallel-implementation convention (see
 * `model/sqlite_model.ts`), this file is SQLite-only and shares no abstraction
 * with other dialects; only the method vocabulary and algorithm are meant to
 * be portable.
 *
 * **Group-name normalization**: group names are only trimmed at this service's
 * boundary in `createGroup`/`updateGroup`/`findByName` — deliberately NOT
 * lowercased, unlike usernames (see `sqlite_admin_accounts.ts`). A group name
 * is a display label, not a login identifier, so case is preserved: "Editors"
 * and "editors" are distinct groups on SQLite and Postgres. (MySQL's default
 * collations compare case-insensitively; see `mysql_admin_groups.ts` for that
 * documented divergence.)
 *
 * **Write ordering instead of transactions**: there is no cross-table
 * transaction primitive in this repo (the same deliberate scope limit as the
 * admin panel's inline persistence; see the module JSDoc of
 * `admin_panel.tsx`), so the two multi-statement operations order their writes
 * fail-closed for permissions. `deleteGroup` deletes membership rows BEFORE
 * the group row, so a failure between the two statements leaves a group
 * without members rather than dangling memberships. `setUserGroups` deletes
 * the user's membership rows BEFORE inserting the new set, so a mid-way
 * failure leaves the user with FEWER groups, never stale extras.
 *
 * **No foreign-key constraints**: consistent with every shipped table factory
 * in this repo, the membership table declares no foreign keys, so membership
 * rows can dangle when a user or group is removed out-of-band. Dangling rows
 * are harmless: `userGroups`/`permissionsForUser` resolve through an inner
 * join, so a membership whose group no longer exists contributes nothing.
 *
 * The type of `db` is made generic over `TSchema` for the same reason as
 * `SQLiteModel` (accepting a `db` built by passing a concrete schema, e.g.
 * `drizzle(client, { schema })`, as-is).
 */
import { asc, eq, getTableColumns } from "drizzle-orm";
import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type {
	AnySQLiteColumn,
	BaseSQLiteDatabase,
	SQLiteTable,
	TableConfig,
} from "drizzle-orm/sqlite-core";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { parseStoredPermissions } from "./admin_permissions.js";

/**
 * Normalizes a group name (trim only — group names are NOT lowercased, unlike
 * usernames; see the module JSDoc for the asymmetry). Applied at the service
 * boundary in `createGroup`/`updateGroup`/`findByName`.
 */
const normalizeGroupName = (name: string): string => name.trim();

/**
 * The type of a Drizzle table with the columns required by
 * `SQLiteAdminGroups` for the groups table. Uses `AnySQLiteColumn` (the same
 * idea as `SQLiteAdminUserRecordTable`) and does not care about the table name
 * or other column layout, so a table extended with app-specific columns still
 * satisfies it.
 */
export type SQLiteAdminGroupRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: string; notNull: true }>;
	name: AnySQLiteColumn<{ data: string; notNull: true }>;
	permissions: AnySQLiteColumn<{ data: string; notNull: true }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
	updatedAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

/**
 * The type of a Drizzle table with the columns required by
 * `SQLiteAdminGroups` for the membership table (one row per user/group pair).
 */
export type SQLiteAdminUserGroupRecordTable = SQLiteTable<TableConfig> & {
	userId: AnySQLiteColumn<{ data: string; notNull: true }>;
	groupId: AnySQLiteColumn<{ data: string; notNull: true }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

/**
 * Row type of a table satisfying `SQLiteAdminGroupRecordTable`, derived from
 * `$inferSelect` (same technique as `SQLiteAdminUserRecord`).
 */
export type SQLiteAdminGroupRecord<TGroups extends SQLiteAdminGroupRecordTable> =
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

/** Options for constructing a `SQLiteAdminGroups`. */
export type SQLiteAdminGroupsOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `SQLiteAdminAccounts`). */
	idGenerator?: IdGenerator;
};

/**
 * Operator-group service backed by two Drizzle sqlite-core tables: a groups
 * table satisfying `SQLiteAdminGroupRecordTable` and a membership table
 * satisfying `SQLiteAdminUserGroupRecordTable`. Both tables are required —
 * feature presence is expressed at the type level by constructing the class,
 * never by optional tables. Generic over the concrete tables so an extended
 * groups table keeps its extra columns typed on returned rows.
 */
export class SQLiteAdminGroups<
	TGroups extends SQLiteAdminGroupRecordTable,
	TUserGroups extends SQLiteAdminUserGroupRecordTable,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly idGenerator: IdGenerator;
	private readonly groups: TGroups;
	/** Named `members` (not `userGroups`) so the field does not collide with the `userGroups` method. */
	private readonly members: TUserGroups;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		tables: { groups: TGroups; userGroups: TUserGroups },
		options: SQLiteAdminGroupsOptions = {},
	) {
		this.groups = tables.groups;
		this.members = tables.userGroups;
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * Internal helpers for referring to the injected tables as `SQLiteTable`
	 * (the concrete type with the generic type parameter erased). The JOIN
	 * query builder's result-type bookkeeping (`AppendToResult`) cannot resolve
	 * for an abstract type parameter and rejects further chaining, so every
	 * JOIN call site uses these getters (the same erase-at-the-verb workaround
	 * as `PgAdminAccounts#pgTable`); non-JOIN verbs keep using the generic
	 * tables directly, and column references always do.
	 */
	private get sqliteGroupsTable(): SQLiteTable {
		return this.groups;
	}

	/** See `sqliteGroupsTable`. */
	private get sqliteUserGroupsTable(): SQLiteTable {
		return this.members;
	}

	/**
	 * Creates a group. The name is trimmed (NOT lowercased — see the module
	 * JSDoc) and must not be empty. A duplicate name is pre-checked via
	 * `findByName` and throws; the table's UNIQUE index is the last line of
	 * defense, so a concurrent insert racing past the pre-check surfaces as a
	 * raw driver error. `permissions` defaults to `[]`. Returns the created row.
	 */
	async createGroup(input: {
		name: string;
		permissions?: readonly string[];
	}): Promise<SQLiteAdminGroupRecord<TGroups>> {
		const name = normalizeGroupName(input.name);
		if (name === "") {
			throw new Error("SQLiteAdminGroups#createGroup: group name must not be empty");
		}
		const existing = await this.findByName(name);
		if (existing !== undefined) {
			throw new Error(`SQLiteAdminGroups#createGroup: group name "${name}" is already taken`);
		}
		const now = Date.now();
		const values = {
			id: this.idGenerator.generate(),
			name,
			permissions: JSON.stringify(input.permissions ?? []),
			createdAt: now,
			updatedAt: now,
		};
		/**
		 * TypeScript cannot statically relate this record to the generic
		 * `$inferInsert` (`TGroups` is opaque at the generic level), so `as` is
		 * used only when passing to `values` (same justification as
		 * `SQLiteAdminAccounts#createUser`).
		 */
		const [row] = await this.db
			.insert(this.groups)
			.values(values as TGroups["$inferInsert"])
			.returning();
		return row;
	}

	/**
	 * Renames the given group and touches `updatedAt`. A `name` in the patch is
	 * trimmed and duplicate-pre-checked (excluding this group's own row).
	 * `permissions`/`id`/timestamps can never pass through this method;
	 * `setGroupPermissions` owns the permission set. Returns the updated row,
	 * or `undefined` when the group does not exist.
	 */
	async updateGroup(
		groupId: string,
		patch: { name?: string },
	): Promise<SQLiteAdminGroupRecord<TGroups> | undefined> {
		const update: Record<string, unknown> = {};
		if (patch.name !== undefined) {
			const name = normalizeGroupName(patch.name);
			if (name === "") {
				throw new Error("SQLiteAdminGroups#updateGroup: group name must not be empty");
			}
			const existing = await this.findByName(name);
			if (existing !== undefined && this.baseRow(existing).id !== groupId) {
				throw new Error(`SQLiteAdminGroups#updateGroup: group name "${name}" is already taken`);
			}
			update.name = name;
		}
		update.updatedAt = Date.now();
		/** `as` for the same generic-`$inferInsert` reason as `createGroup`. */
		const [row] = await this.db
			.update(this.groups)
			.set(update as Partial<TGroups["$inferInsert"]>)
			.where(eq(this.groups.id, groupId))
			.returning();
		return row;
	}

	/**
	 * Deletes the given group. Membership rows are deleted FIRST, then the
	 * group row: there is no cross-table transaction primitive in this repo
	 * (see the module JSDoc), so the order is chosen fail-closed — a failure
	 * between the two statements leaves a group without members rather than
	 * memberships pointing at a deleted group. A missing group is a no-op.
	 */
	async deleteGroup(groupId: string): Promise<void> {
		await this.db.delete(this.members).where(eq(this.members.groupId, groupId));
		await this.db.delete(this.groups).where(eq(this.groups.id, groupId));
	}

	/** Fetches a single group by id. Returns `undefined` if it doesn't exist. */
	async retrieve(groupId: string): Promise<SQLiteAdminGroupRecord<TGroups> | undefined> {
		const [row] = await this.db
			.select()
			.from(this.groups)
			.where(eq(this.groups.id, groupId))
			.limit(1);
		return row;
	}

	/** Fetches a single group by name (trimmed before lookup, never lowercased). Returns `undefined` if it doesn't exist. */
	async findByName(name: string): Promise<SQLiteAdminGroupRecord<TGroups> | undefined> {
		const normalized = normalizeGroupName(name);
		const [row] = await this.db
			.select()
			.from(this.groups)
			.where(eq(this.groups.name, normalized))
			.limit(1);
		return row;
	}

	/** Lists every group ordered by name ascending. */
	async listGroups(): Promise<SQLiteAdminGroupRecord<TGroups>[]> {
		return this.db.select().from(this.groups).orderBy(asc(this.groups.name));
	}

	/**
	 * Replaces the group's whole permission set with a single UPDATE (and
	 * touches `updatedAt`). The single-statement replacement keeps a
	 * permission-set change atomic: no reader can observe a half-applied set
	 * (same reasoning as `SQLiteAdminAccounts#setUserPermissions`). A missing
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
	 * statements are not transactional (see the module JSDoc) and are
	 * deliberately ordered so a mid-way failure leaves the user with FEWER
	 * groups (fail-closed for permissions), never stale extras — re-run this
	 * method on error. An empty array removes every membership. Group ids are
	 * NOT validated to exist: an unknown id produces a membership row that
	 * `userGroups`/`permissionsForUser` ignore (inner join).
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
	async userGroups(userId: string): Promise<SQLiteAdminGroupRecord<TGroups>[]> {
		/**
		 * The selection spreads every column of the groups table
		 * (`getTableColumns`), so each result row is exactly a row of `TGroups`;
		 * the generic table's column map is opaque to TypeScript (same
		 * justification style as `baseRow`), so `as` is used only on the result.
		 */
		const rows = await this.db
			.select(getTableColumns(this.sqliteGroupsTable))
			.from(this.sqliteUserGroupsTable)
			.innerJoin(this.sqliteGroupsTable, eq(this.members.groupId, this.groups.id))
			.where(eq(this.members.userId, userId))
			.orderBy(asc(this.groups.name));
		return rows as SQLiteAdminGroupRecord<TGroups>[];
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
	 * permission set (`SQLiteAdminAccounts#userPermissions`); the superuser
	 * bypass lives with the consumer, not here.
	 */
	async permissionsForUser(userId: string): Promise<string[]> {
		const rows = await this.db
			.select({ permissions: this.groups.permissions })
			.from(this.sqliteUserGroupsTable)
			.innerJoin(this.sqliteGroupsTable, eq(this.members.groupId, this.groups.id))
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
	 * but every table satisfying `SQLiteAdminGroupRecordTable` structurally
	 * carries these columns with exactly these data types, so `as` is used only
	 * here (same justification style as `SQLiteAdminAccounts#baseRow`).
	 */
	private baseRow(row: SQLiteAdminGroupRecord<TGroups>): AdminGroupBaseRow {
		return row as AdminGroupBaseRow;
	}
}

/**
 * Factory that returns a default schema satisfying
 * `SQLiteAdminGroupRecordTable`. The table name can be changed via the
 * `tableName` argument (defaults to `"admin_groups"`). Migration generation is
 * left to the app via drizzle-kit (this factory only provides the schema
 * definition).
 */
export const sqliteAdminGroupsTable = (tableName = "admin_groups") =>
	sqliteTable(
		tableName,
		{
			id: text("id").primaryKey(),
			name: text("name").notNull(),
			permissions: text("permissions").notNull().default("[]"),
			createdAt: integer("created_at").notNull(),
			updatedAt: integer("updated_at").notNull(),
		},
		(t) => [
			/** Uniqueness of the (trimmed) group name; `createGroup`'s pre-check is advisory, this index is authoritative. */
			uniqueIndex(`${tableName}_name_idx`).on(t.name),
		],
	) satisfies SQLiteAdminGroupRecordTable;

/**
 * Factory that returns a default membership schema satisfying
 * `SQLiteAdminUserGroupRecordTable`. The table name can be changed via the
 * `tableName` argument (defaults to `"admin_user_groups"`). No foreign-key
 * constraints are declared (see the module JSDoc). Migration generation is
 * left to the app via drizzle-kit (this factory only provides the schema
 * definition).
 */
export const sqliteAdminUserGroupsTable = (tableName = "admin_user_groups") =>
	sqliteTable(
		tableName,
		{
			userId: text("user_id").notNull(),
			groupId: text("group_id").notNull(),
			createdAt: integer("created_at").notNull(),
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
	) satisfies SQLiteAdminUserGroupRecordTable;
