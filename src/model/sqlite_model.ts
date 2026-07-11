/**
 * Thin abstract base class on top of Drizzle (sqlite-core).
 *
 * **Parallel per-dialect implementations**: because Drizzle's type system for
 * SQLite/Postgres/MySQL is mutually incompatible across dialects, we do not build a
 * shared abstract base. Instead each dialect gets its own implementation: `SQLiteModel`
 * (this file), `PgModel` (`pg_model.ts`), and `MySqlModel`. The method vocabulary
 * (`retrieve`/`create`/`update`/`updateWhere`/`upsert`/`increment`/`with`, etc.) and the
 * JSDoc design decisions are kept aligned across dialects, but code sharing is limited to
 * dialect-independent parts such as `IdGenerator` injection.
 *
 * Drizzle is already an excellent ORM layer, so we don't wrap it deeply: subclasses are
 * free to write `this.db.select()...` directly inside their methods. What the base class
 * absorbs is limited to the boilerplate repeated across every model (id generation,
 * automatic `createdAt`/`updatedAt` management, cursor pagination, optimistic-lock
 * UPDATE, transaction binding).
 *
 * `db` is typed as `BaseSQLiteDatabase<"async", unknown, TSchema>` (`TRunResult` fixed to
 * `unknown`). Following the runtime-agnostic, backend-not-fixed principle, this
 * lets any SQLite driver's `drizzle()` instance be accepted — libSQL
 * (`@libsql/client`'s `ResultSet`), D1 (`D1Result`), etc. (`TRunResult` only appears as
 * the return type of `db.run()`, and `SQLiteModel` never reads that return value, so
 * fixing it loses no type information we actually use. `SQLiteDatabaseSessionStorage` in
 * `sqlite_database_session_storage.ts` adopts the same type.)
 *
 * Deliberately not provided:
 * - Lifecycle callbacks (before/after hooks): hard-to-trace magic
 * - Validation: that's the Form layer's responsibility; the model stays a thin DB layer
 *   that trusts already-normalized input
 */
import {
	and,
	asc,
	count as countRows,
	desc,
	eq,
	getTableColumns,
	getTableName,
	gt,
	inArray,
	lt,
	sql,
	type GetColumnData,
	type SQL,
} from "drizzle-orm";
import type { BaseSQLiteDatabase, SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { StaleRecordError } from "./stale_record_error.js";

/** Column names that `SQLiteModel` manages automatically, when the table actually has them. */
type AutoManagedKey = "id" | "createdAt" | "updatedAt";

/**
 * Default upper bound on the number of values accepted by `listIn`/`groupedIn`/
 * `retrieveMany` (methods that pass a set of values to an `IN` clause). Chosen with
 * SQLite's bound-parameter limit in mind (`SQLITE_MAX_VARIABLE_NUMBER`, which varies by
 * version/build but is roughly 999-32766), while staying large enough not to break
 * existing call sites. Can be overridden via `SQLiteModel`'s third constructor argument.
 */
const DEFAULT_MAX_IN_VALUES = 1000;

/**
 * Input type for `create`/`createMany`. Makes the `id`/`createdAt`/`updatedAt` columns
 * optional when the table has them (since the base class fills them in automatically).
 * For tables that don't have them (e.g. a table whose primary key is `code`), this
 * transform is a no-op and other required columns stay required.
 */
type Creatable<TTable extends SQLiteTable> = Omit<TTable["$inferInsert"], AutoManagedKey> &
	Partial<Pick<TTable["$inferInsert"], Extract<keyof TTable["$inferInsert"], AutoManagedKey>>>;

/**
 * Derives a SQLite table's row type from `$inferSelect` (specific to `SQLiteModel`; the
 * Postgres counterpart is `PgModelRecord`). Replaces the hand-written
 * `NonNullable<Awaited<ReturnType<...>>>` pattern.
 */
export type SQLiteModelRecord<TTable extends SQLiteTable> = TTable["$inferSelect"];

/**
 * Arguments for `SQLiteModel#paginate`. The cursor is the primary key value of the last
 * row of the previous page, in the order given by `direction`. Defaults to `"asc"` when
 * `direction` is omitted (for backward compatibility).
 */
export type SQLitePaginateOptions<TPk extends SQLiteColumn> = {
	cursor?: GetColumnData<TPk, "raw">;
	limit: number;
	direction?: "asc" | "desc";
	/** Optional filter condition, ANDed with the cursor condition. For search/scoped listings. */
	where?: SQL;
};

/** Return value of `SQLiteModel#paginate`. */
export type SQLitePaginateResult<TTable extends SQLiteTable, TPk extends SQLiteColumn> = {
	rows: SQLiteModelRecord<TTable>[];
	nextCursor: GetColumnData<TPk, "raw"> | null;
	hasMore: boolean;
};

/** Arguments for `SQLiteModel#listPage`. */
export type SQLiteListPageOptions = {
	where?: SQL;
	/** Sort columns, applied in array order. Defaults to primary key ascending when omitted or empty. */
	orderBy?: { column: SQLiteColumn; direction: "asc" | "desc" }[];
	limit: number;
	offset?: number;
};

/**
 * Conflict resolution for `SQLiteModel#upsert`. `target` is the column(s) making up the
 * UNIQUE constraint, `set` is what to update on conflict.
 */
export type SQLiteUpsertConflict<TTable extends SQLiteTable> = {
	target: SQLiteColumn | SQLiteColumn[];
	set: Partial<TTable["$inferInsert"]>;
};

export abstract class SQLiteModel<
	TTable extends SQLiteTable,
	TPk extends SQLiteColumn,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	constructor(
		protected readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly idGenerator: IdGenerator = new SnowflakeIdGenerator(),
		private readonly maxInValues: number = DEFAULT_MAX_IN_VALUES,
	) {}

	/** Target table. Declared by the subclass (e.g. `protected get table() { return items; }`). */
	protected abstract get table(): TTable;

	/** Primary key column. Declared by the subclass (e.g. `protected get primaryKey() { return items.id; }`). */
	protected abstract get primaryKey(): TPk;

	/** Fetches a single row by primary key. Returns `undefined` if it doesn't exist. */
	async retrieve(pk: GetColumnData<TPk, "raw">): Promise<SQLiteModelRecord<TTable> | undefined> {
		const [row] = await this.db.select().from(this.table).where(eq(this.primaryKey, pk)).limit(1);
		return row;
	}

	/**
	 * Fetches a single row by an arbitrary condition. Returns `undefined` if none match;
	 * if multiple rows match, only the first is returned. `where` is typed as
	 * `SQL | undefined` (the same type Drizzle's `.where()` accepts) so that a value
	 * built dynamically from a condition array (e.g. via `and(...)`) can be passed
	 * straight through. The parameter itself is required (not optional) to encourage
	 * callers to be explicit about their condition.
	 */
	async retrieveBy(where: SQL | undefined): Promise<SQLiteModelRecord<TTable> | undefined> {
		const [row] = await this.db.select().from(this.table).where(where).limit(1);
		return row;
	}

	/**
	 * Returns every row matching `where` (all rows if `where` is omitted). There is no
	 * row limit, so on large tables this can load an unbounded result set into memory.
	 * Use `paginate` when the result set may be large.
	 */
	async list(where?: SQL): Promise<SQLiteModelRecord<TTable>[]> {
		return this.db.select().from(this.table).where(where);
	}

	/** Whether at least one row matches `where`. */
	async exists(where?: SQL): Promise<boolean> {
		const [row] = await this.db
			.select({ found: sql<number>`1` })
			.from(this.table)
			.where(where)
			.limit(1);
		return row !== undefined;
	}

	/** Number of rows matching `where`. */
	async count(where?: SQL): Promise<number> {
		const [row] = await this.db.select({ value: countRows() }).from(this.table).where(where);
		return row?.value ?? 0;
	}

	/** Returns only the values of the given column as an array (all rows if `where` is omitted). */
	async pluck<TColumn extends SQLiteColumn>(
		column: TColumn,
		where?: SQL,
	): Promise<GetColumnData<TColumn>[]> {
		const rows = await this.db.select({ value: column }).from(this.table).where(where);
		return rows.map((row) => row.value);
	}

	/**
	 * Returns every row whose `column` value matches one of `values`
	 * (`WHERE column IN (values)`). A vocabulary for bulk-fetching by a set of parent
	 * IDs/FKs, avoiding an N+1 pattern of calling `retrieve`/`list` in a loop (also the
	 * basis of `groupedIn`/`retrieveMany`). If `values` is an empty array, no query is
	 * issued and `[]` is returned (an empty `IN ()` is invalid SQL syntax). If
	 * `values.length` exceeds the third constructor argument `maxInValues` (default
	 * `1000`), no query is issued and this throws instead (a guard against unbounded
	 * `IN` clause expansion; use `paginate`'s `where` for large-scale filtering).
	 */
	async listIn<TColumn extends SQLiteColumn>(
		column: TColumn,
		values: readonly GetColumnData<TColumn, "raw">[],
	): Promise<SQLiteModelRecord<TTable>[]> {
		if (values.length === 0) return [];
		this.assertWithinMaxInValues(values.length);
		return this.db.select().from(this.table).where(inArray(column, values));
	}

	/**
	 * Performs the same fetch as `listIn` but returns a `Map` grouped by the `column`
	 * value. A vocabulary for bulk-loading a "has many" relation without an N+1 pattern
	 * of calling `list` in a loop (`groupedIn(fkColumn, parentIds)` yields
	 * `parentId -> childRows[]`). A column value with no matching rows in `values`
	 * simply has no key in the map. Returns an empty map (no query issued) if `values`
	 * is empty.
	 *
	 * Since the grouping key is the value of a dynamic column (`column`), TypeScript
	 * cannot statically track it as a property name of `SQLiteModelRecord<TTable>`, so
	 * it's read using the same technique as `paginate`'s `__cursor` (aliasing `column`
	 * as `__group` in the `select` and destructuring it back off). The `values.length`
	 * upper-bound guard is the same as `listIn` (throws once `maxInValues` is exceeded).
	 */
	async groupedIn<TColumn extends SQLiteColumn>(
		column: TColumn,
		values: readonly GetColumnData<TColumn, "raw">[],
	): Promise<Map<GetColumnData<TColumn, "raw">, SQLiteModelRecord<TTable>[]>> {
		const grouped = new Map<GetColumnData<TColumn, "raw">, SQLiteModelRecord<TTable>[]>();
		if (values.length === 0) return grouped;
		this.assertWithinMaxInValues(values.length);

		const fetched = await this.db
			.select({ ...getTableColumns(this.table), __group: column })
			.from(this.table)
			.where(inArray(column, values));

		for (const { __group, ...record } of fetched) {
			/** The structural reason `record` matches `SQLiteModelRecord<TTable>` is the same as in `paginate`. */
			const row = record as SQLiteModelRecord<TTable>;
			const bucket = grouped.get(__group);
			if (bucket) bucket.push(row);
			else grouped.set(__group, [row]);
		}
		return grouped;
	}

	/**
	 * Bulk-fetches by an array of primary keys and returns `Map<primaryKeyValue, row>`.
	 * A vocabulary for bulk-loading a "belongs to" relation without an N+1 pattern of
	 * calling `retrieve` in a loop (`retrieveMany(parentIds)`). A primary key that
	 * doesn't exist simply has no key in the map. Returns an empty map (no query
	 * issued) if `pks` is empty. Duplicate primary keys still result in a single query
	 * (an `IN` clause tolerates duplicates, and the result only contains rows that
	 * actually exist). The `pks.length` upper-bound guard is the same as `listIn`
	 * (throws once `maxInValues` is exceeded).
	 */
	async retrieveMany(
		pks: readonly GetColumnData<TPk, "raw">[],
	): Promise<Map<GetColumnData<TPk, "raw">, SQLiteModelRecord<TTable>>> {
		const result = new Map<GetColumnData<TPk, "raw">, SQLiteModelRecord<TTable>>();
		if (pks.length === 0) return result;
		this.assertWithinMaxInValues(pks.length);

		const fetched = await this.db
			.select({ ...getTableColumns(this.table), __pk: this.primaryKey })
			.from(this.table)
			.where(inArray(this.primaryKey, pks));

		for (const { __pk, ...record } of fetched) {
			result.set(__pk, record as SQLiteModelRecord<TTable>);
		}
		return result;
	}

	/**
	 * Cursor-based pagination (`OFFSET` is intentionally avoided, in consideration of
	 * Turso's rows-read billing).
	 *
	 * Contract: sort order is fixed to primary key order in the direction given by
	 * `direction` (default `"asc"`). `cursor` is the primary key value of the last row
	 * of the previous page; rows are returned starting after `primaryKey > cursor` for
	 * `asc`, or before `primaryKey < cursor` for `desc` (starts from the beginning if
	 * `cursor` is omitted). Fetches `limit + 1` rows; if more than `limit` rows come
	 * back, `hasMore: true` is set, `rows` returns only the first `limit` of them, and
	 * `nextCursor` is the primary key value of that last row. If the primary key is a
	 * monotonically increasing, time-ordered value (such as the Snowflake ID that is
	 * this framework's default), `asc` matches insertion order and `desc` (pass
	 * `direction: "desc"`) matches a "most recent first" listing.
	 *
	 * Passing `where` allows pagination combined with filtering (ANDed with the cursor
	 * condition).
	 */
	async paginate({
		cursor,
		limit,
		direction = "asc",
		where,
	}: SQLitePaginateOptions<TPk>): Promise<SQLitePaginateResult<TTable, TPk>> {
		const cursorCondition =
			cursor === undefined
				? undefined
				: direction === "desc"
					? lt(this.primaryKey, cursor)
					: gt(this.primaryKey, cursor);
		const condition =
			cursorCondition && where ? and(cursorCondition, where) : (cursorCondition ?? where);
		const fetched = await this.db
			.select({ ...getTableColumns(this.table), __cursor: this.primaryKey })
			.from(this.table)
			.where(condition)
			.orderBy(direction === "desc" ? desc(this.primaryKey) : asc(this.primaryKey))
			.limit(limit + 1);

		const hasMore = fetched.length > limit;
		const page = hasMore ? fetched.slice(0, limit) : fetched;
		const rows = page.map(({ __cursor, ...record }) => record);
		const last = page.at(-1);
		const nextCursor = hasMore && last !== undefined ? last.__cursor : null;

		/**
		 * `record` is `getTableColumns` (every column of the table) with only the
		 * `__cursor` alias removed, so it structurally matches `SQLiteModelRecord<TTable>`,
		 * but TypeScript cannot statically track that a destructuring removal matches
		 * `$inferSelect`, so `as` is used only here.
		 */
		return { rows: rows as SQLiteModelRecord<TTable>[], nextCursor, hasMore };
	}

	/**
	 * Offset-based pagination in arbitrary column order. Where `paginate` is cursor-based
	 * and fixed to primary key order (chosen with Turso's rows-read billing in mind, so it
	 * scales cheaply to large result sets), `listPage` trades that for the flexibility of
	 * sorting by any column and jumping straight to a given page number — the shape a
	 * column-sortable, numbered-page admin listing needs. Prefer `paginate` for
	 * large-scale, publicly listed data: a large `offset` still requires the database to
	 * scan and discard that many rows before returning results, so `listPage` is best
	 * suited to bounded, internal-facing listings (e.g. an admin panel) rather than deep
	 * pagination over unbounded public data.
	 *
	 * `orderBy` is applied in array order; when omitted or empty, rows are sorted by
	 * primary key ascending so results stay deterministic across calls. `offset` defaults
	 * to `0`.
	 */
	async listPage(options: SQLiteListPageOptions): Promise<SQLiteModelRecord<TTable>[]> {
		const orderBy =
			options.orderBy && options.orderBy.length > 0
				? options.orderBy.map((entry) =>
						entry.direction === "desc" ? desc(entry.column) : asc(entry.column),
					)
				: [asc(this.primaryKey)];
		return this.db
			.select()
			.from(this.table)
			.where(options.where)
			.orderBy(...orderBy)
			.limit(options.limit)
			.offset(options.offset ?? 0);
	}

	/**
	 * Creates a single row. Automatically fills in `id`/`createdAt`/`updatedAt` when the
	 * table has them.
	 *
	 * Automatic `id` generation assumes the `id` column is a **string (text)** type
	 * holding the numeric string returned by the `IdGenerator` (Snowflake by default).
	 * For tables whose `id` column is an integer PRIMARY KEY (SQLite's `AUTOINCREMENT`,
	 * etc.) this assumption doesn't hold, so either pass `id` explicitly instead of
	 * relying on auto-generation, or don't use this base class's `create` at all.
	 */
	async create(input: Creatable<TTable>): Promise<SQLiteModelRecord<TTable>> {
		const [row] = await this.db.insert(this.table).values(this.withAutoFields(input)).returning();
		return row;
	}

	/** Bulk-creates multiple rows, generating a separate id for each. Passing an empty array is a no-op returning `[]`. */
	async createMany(inputs: Creatable<TTable>[]): Promise<SQLiteModelRecord<TTable>[]> {
		if (inputs.length === 0) return [];
		const values = inputs.map((input) => this.withAutoFields(input));
		return this.db.insert(this.table).values(values).returning();
	}

	/**
	 * Updates a single row by primary key. `updatedAt` (when present on the table) is
	 * always overwritten with the current time, regardless of what the caller passes.
	 * Returns `undefined` if the target row doesn't exist.
	 */
	async update(
		pk: GetColumnData<TPk, "raw">,
		patch: Partial<TTable["$inferInsert"]>,
	): Promise<SQLiteModelRecord<TTable> | undefined> {
		const [row] = await this.db
			.update(this.table)
			.set(this.withTouchedUpdatedAt(patch))
			.where(eq(this.primaryKey, pk))
			.returning();
		return row;
	}

	/**
	 * Bulk-updates every row matching `where` and returns the number of rows actually
	 * updated. Provides `WHERE status = 'unused'`-style optimistic locking as a
	 * first-class method (`redeem` in `src/models/serial_codes.ts` was the prototype).
	 * `updatedAt` is handled the same as `update`. `where` is typed `SQL | undefined`
	 * (required, not optional) for the same reason as `retrieveBy`.
	 *
	 * The count is not read from the driver's raw execution result (e.g.
	 * `ResultSet.rowsAffected`); it's the length of the row array returned by
	 * `.returning({ pk: this.primaryKey })` (SQLite's UPDATE/DELETE dialect supports
	 * `RETURNING`, typed via `SQLiteUpdateBase#returning`, confirmed in
	 * `node_modules/drizzle-orm/sqlite-core/query-builders/update.d.ts`). This keeps
	 * `db`'s type independent from any driver-specific execution result type (libSQL's
	 * `ResultSet`, D1's `D1Result`, etc.), consistent with the runtime-agnostic design
	 * (so `SQLiteModel` works across libSQL, D1, and other sqlite-core drivers).
	 */
	async updateWhere(
		where: SQL | undefined,
		patch: Partial<TTable["$inferInsert"]>,
	): Promise<number> {
		const updated = await this.db
			.update(this.table)
			.set(this.withTouchedUpdatedAt(patch))
			.where(where)
			.returning({ pk: this.primaryKey });
		return updated.length;
	}

	/**
	 * Optimistic-locking update (using a version column). A formalization
	 * of conditional updates built on `updateWhere`: pass the `lockVersion` carried over
	 * from a previous read as `expectedVersion`, and this updates
	 * `WHERE primaryKey = pk AND lockVersion = expectedVersion`, incrementing
	 * `lockVersion` to `expectedVersion + 1` on success. `updatedAt` (when present on
	 * the table) is handled the same as `update`.
	 *
	 * Both "the row is gone" and "version mismatch" result in a zero-row update and
	 * can't be distinguished at the SQL level, so either case throws
	 * `StaleRecordError` (see `StaleRecordError`'s JSDoc). Even if `patch` includes
	 * `lockVersion`, it gets overwritten by the value this method manages
	 * (`expectedVersion + 1`).
	 *
	 * ```ts
	 * const item = await items.retrieve(id);
	 * if (!item) throw new Error("not found");
	 * const updated = await items.updateLocked(id, item.lockVersion, { name: "New name" });
	 * ```
	 */
	async updateLocked(
		pk: GetColumnData<TPk, "raw">,
		expectedVersion: number,
		patch: Partial<TTable["$inferInsert"]>,
	): Promise<SQLiteModelRecord<TTable>> {
		const lockVersion = this.lockVersionColumn();
		const nextPatch = {
			...this.withTouchedUpdatedAt(patch),
			lockVersion: expectedVersion + 1,
		} as Partial<TTable["$inferInsert"]>;
		const [row] = await this.db
			.update(this.table)
			.set(nextPatch)
			.where(and(eq(this.primaryKey, pk), eq(lockVersion, expectedVersion)))
			.returning();
		if (!row) throw new StaleRecordError(getTableName(this.table), pk);
		return row;
	}

	/**
	 * Sets `deletedAt` to the current time (soft delete). Return value and the
	 * `updatedAt`-touching behavior follow `update`, and this delegates its
	 * implementation to `update`. Returns `undefined` if the target row doesn't exist.
	 * Calling this on an already soft-deleted row is not special-cased; it simply
	 * overwrites `deletedAt` with a newer timestamp.
	 *
	 * Fetch methods like `list`/`retrieve` do not automatically exclude rows with a
	 * non-null `deletedAt` (an implicit global scope is deliberately not
	 * provided, per the "no magic" policy). Callers that want to exclude deleted rows
	 * must add `isNull(table.deletedAt)` to `where` explicitly.
	 */
	async softDelete(pk: GetColumnData<TPk, "raw">): Promise<SQLiteModelRecord<TTable> | undefined> {
		this.assertDeletedAtColumn();
		return this.update(pk, { deletedAt: Date.now() } as Partial<TTable["$inferInsert"]>);
	}

	/** Resets `deletedAt` to `null` (undoes a soft delete). Contract and delegation target match `softDelete`. */
	async restore(pk: GetColumnData<TPk, "raw">): Promise<SQLiteModelRecord<TTable> | undefined> {
		this.assertDeletedAtColumn();
		return this.update(pk, { deletedAt: null } as Partial<TTable["$inferInsert"]>);
	}

	/**
	 * Updates using `set` on conflict on `target` (the UNIQUE constraint column(s)),
	 * otherwise creates a new row from `input`. `updatedAt` is handled the same as
	 * `update`.
	 */
	async upsert(
		input: Creatable<TTable>,
		conflict: SQLiteUpsertConflict<TTable>,
	): Promise<SQLiteModelRecord<TTable>> {
		const [row] = await this.db
			.insert(this.table)
			.values(this.withAutoFields(input))
			.onConflictDoUpdate({ target: conflict.target, set: this.withTouchedUpdatedAt(conflict.set) })
			.returning();
		return row;
	}

	/** Updates only `updatedAt` to the current time. A no-op if the table has no `updatedAt` column. */
	async touch(pk: GetColumnData<TPk, "raw">): Promise<void> {
		if (!("updatedAt" in this.table)) return;
		await this.db
			.update(this.table)
			.set(this.withTouchedUpdatedAt({}))
			.where(eq(this.primaryKey, pk));
	}

	/**
	 * Adds `delta` (default 1) to the given column, issuing SQL as
	 * `column = column + delta` (since `.set()`'s typed builder requires JS-side key
	 * names — the declared column property names — but this method needs to accept an
	 * arbitrary column generically and can't know those statically, it uses a raw-SQL
	 * path that embeds the table/column directly into a `sql` template; Drizzle's `sql`
	 * tag correctly quotes embedded `Table`/`Column` values as identifiers). Whether the
	 * column is numeric is left to the runtime SQL (a narrower type-level puzzle than
	 * `SQLiteColumn` is deliberately not attempted, per the "prefer the straightforward
	 * type" policy).
	 *
	 * The left-hand side of `SET` (the assignment target) must be an unqualified,
	 * bare column name per SQLite syntax (`SET "items"."count" = ...` is a syntax
	 * error, confirmed against a real database), so only the left side uses
	 * `sql.identifier(column.name)` to produce a bare identifier, while the right-hand
	 * side reference stays as `${column}` (table-qualified).
	 */
	async increment(pk: GetColumnData<TPk, "raw">, column: SQLiteColumn, delta = 1): Promise<void> {
		await this.db.run(
			sql`update ${this.table} set ${sql.identifier(column.name)} = ${column} + ${delta} where ${eq(this.primaryKey, pk)}`,
		);
	}

	/** Subtracts `delta` (default 1) from the given column. The sign-flipped counterpart of `increment`. */
	async decrement(pk: GetColumnData<TPk, "raw">, column: SQLiteColumn, delta = 1): Promise<void> {
		await this.increment(pk, column, -delta);
	}

	/** Deletes a single row by primary key. Returns the deleted row (`undefined` if it didn't exist). */
	async delete(pk: GetColumnData<TPk, "raw">): Promise<SQLiteModelRecord<TTable> | undefined> {
		const [row] = await this.db.delete(this.table).where(eq(this.primaryKey, pk)).returning();
		return row;
	}

	/**
	 * Bulk-deletes every row matching `where` and returns the number of rows actually
	 * deleted (the DELETE counterpart of `updateWhere`, sharing the same `where`
	 * contract). `where` is typed `SQL | undefined` (required, not optional) for the
	 * same reason as `retrieveBy`.
	 *
	 * **This is a hard delete** — it issues a real `DELETE` statement, unlike
	 * `softDelete`, which only sets `deletedAt`. `deleteWhere` does not auto-scope to
	 * non-deleted rows; the caller's `where` is authoritative, so callers that want to
	 * skip already soft-deleted rows must add that condition themselves (e.g.
	 * `isNull(table.deletedAt)`).
	 *
	 * The count is derived the same way as `updateWhere`: the length of the row array
	 * returned by `.returning({ pk: this.primaryKey })` (SQLite's DELETE also supports
	 * `RETURNING`, typed via `SQLiteDeleteBase#returning`, confirmed in
	 * `node_modules/drizzle-orm/sqlite-core/query-builders/delete.d.ts`), for the same
	 * driver-independence reason given in `updateWhere`'s JSDoc.
	 */
	async deleteWhere(where: SQL | undefined): Promise<number> {
		const deleted = await this.db
			.delete(this.table)
			.where(where)
			.returning({ pk: this.primaryKey });
		return deleted.length;
	}

	/**
	 * Returns a model instance of the same type bound to a transaction. Used in
	 * cross-model orchestration (the handlers layer) like
	 * `db.transaction(async (tx) => { const txBooks = books.with(tx); ... })`.
	 */
	with(tx: BaseSQLiteDatabase<"async", unknown, TSchema>): this {
		/**
		 * `this.constructor` refers to the subclass at runtime (e.g. `ItemModel`), but
		 * TypeScript cannot statically track `this`'s concrete constructor type.
		 * Assuming the subclass inherits `SQLiteModel`'s constructor signature
		 * `(db, idGenerator?)` unchanged (i.e. it doesn't define its own constructor),
		 * `as` is used only here to make the constructor type explicit.
		 */
		const Ctor = this.constructor as new (
			db: BaseSQLiteDatabase<"async", unknown, TSchema>,
			idGenerator?: IdGenerator,
			maxInValues?: number,
		) => this;
		return new Ctor(tx, this.idGenerator, this.maxInValues);
	}

	/**
	 * Builds the values to insert with `id`/`createdAt`/`updatedAt` filled in (only for
	 * columns the table actually has). Presence is checked at runtime via `in` against
	 * `this.table`'s actual properties, so a column absent from the table is never
	 * mistakenly inserted. Because TypeScript cannot statically track this
	 * per-table-varying dynamic column shape, `as` is used only when returning the
	 * value.
	 *
	 * If the `id` column is an integer type (e.g. `AUTOINCREMENT`), the numeric string
	 * assigned here from the `IdGenerator` would be passed straight into an integer
	 * column, producing an unintended value. See `create`'s JSDoc.
	 */
	private withAutoFields(input: Creatable<TTable>): TTable["$inferInsert"] {
		const now = Date.now();
		const values: Record<string, unknown> = { ...input };
		if ("id" in this.table && values.id === undefined) {
			values.id = this.idGenerator.generate();
		}
		if ("createdAt" in this.table && values.createdAt === undefined) {
			values.createdAt = now;
		}
		if ("updatedAt" in this.table && values.updatedAt === undefined) {
			values.updatedAt = now;
		}
		return values as TTable["$inferInsert"];
	}

	/**
	 * Returns `patch` with `updatedAt` (only if the table has it) overwritten with the
	 * current time. Uses `as` only when returning, for the same reason as
	 * `withAutoFields`.
	 */
	private withTouchedUpdatedAt(
		patch: Partial<TTable["$inferInsert"]>,
	): Partial<TTable["$inferInsert"]> {
		if (!("updatedAt" in this.table)) return patch;
		return { ...patch, updatedAt: Date.now() } as Partial<TTable["$inferInsert"]>;
	}

	/**
	 * Returns the `lockVersion` column used by `updateLocked`. Presence is checked at
	 * runtime with the same technique as `withAutoFields` (the `in` operator); throws
	 * with a clear message if the table has no `lockVersion` column.
	 */
	private lockVersionColumn(): SQLiteColumn {
		if (!("lockVersion" in this.table)) {
			throw new Error(
				`SQLiteModel#updateLocked: table "${getTableName(this.table)}" has no lockVersion column. ` +
					"Add a lockVersion column (integer, NOT NULL, initial value 0) to the table to use optimistic locking.",
			);
		}
		return this.table.lockVersion as SQLiteColumn;
	}

	/**
	 * Verifies the presence of the `deletedAt` column used by `softDelete`/`restore`.
	 * Presence is checked at runtime with the same technique as `lockVersionColumn`
	 * (the `in` operator); throws with a clear message if the table has no `deletedAt`
	 * column.
	 */
	private assertDeletedAtColumn(): void {
		if (!("deletedAt" in this.table)) {
			throw new Error(
				`SQLiteModel#softDelete: table "${getTableName(this.table)}" has no deletedAt column. ` +
					"Add a deletedAt column (integer, nullable) to the table to use soft delete.",
			);
		}
	}

	/**
	 * Guard used by `listIn`/`groupedIn`/`retrieveMany` to check that the number of
	 * values passed to an `IN` clause doesn't exceed the third constructor argument
	 * `maxInValues`. Throws with a clear message if it's exceeded (principle 4, "no
	 * magic": rather than silently truncating an overflowing value set, it nudges
	 * callers toward `paginate` instead).
	 */
	private assertWithinMaxInValues(length: number): void {
		if (length > this.maxInValues) {
			throw new Error(
				`SQLiteModel: number of values passed to IN clause (${length}) exceeds the limit (${this.maxInValues}). ` +
					"Use paginate(where) for large-scale filtering.",
			);
		}
	}
}
