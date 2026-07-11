/**
 * Thin abstract base class on top of Drizzle (pg-core). Implements the same contract
 * (method vocabulary, design decisions) as `SQLiteModel` in `sqlite_model.ts`, ported in
 * parallel for pg-core (parallel per-dialect implementations, not unified generics.
 * Drizzle's SQLite/Postgres/MySQL type systems are mutually incompatible, so no shared
 * abstract base is built; only dialect-independent parts such as `IdGenerator` injection
 * share code).
 *
 * `db` is typed as `PgDatabase<TQueryResult, TSchema>`, promoting
 * `TQueryResult extends PgQueryResultHKT` to `PgModel`'s own class type parameter.
 * SQLite's `SQLiteModel` was able to fix `TRunResult` to `unknown` (it only appears as
 * the return type of `db.run()`, which is never read), but pg-core's `TQueryResult` is a
 * constrained generic following the higher-kinded-type (HKT) pattern, and `unknown`
 * does not satisfy `PgQueryResultHKT` (an interface carrying `$brand`/`row`/`type`),
 * confirmed in `node_modules/drizzle-orm/pg-core/session.d.ts`, so it can't be fixed.
 * `PostgresJsDatabase`, `NeonHttpDatabase`, and `PgliteDatabase` each extend
 * `PgDatabase<THKT, TSchema>` with a different HKT — `PostgresJsQueryResultHKT`,
 * `NeonHttpQueryResultHKT`, `PgliteQueryResultHKT` respectively (confirmed in
 * `node_modules/drizzle-orm/{postgres-js,neon-http,pglite}/driver.d.ts`) — so accepting
 * `TQueryResult` as a class type parameter on `PgModel<TTable, TPk, TQueryResult, TSchema>`
 * lets any Postgres driver's `drizzle()` instance be assigned.
 *
 * Drizzle is already an excellent ORM layer, so we don't wrap it deeply: subclasses are
 * free to write `this.db.select()...` directly. What the base class absorbs is limited
 * to the boilerplate repeated across every model (id generation, automatic
 * `createdAt`/`updatedAt` management, cursor pagination, optimistic-lock UPDATE,
 * transaction binding), same policy as `SQLiteModel`.
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
import type { PgColumn, PgDatabase, PgQueryResultHKT, PgTable } from "drizzle-orm/pg-core";
import { SnowflakeIdGenerator } from "../support/id_generator.js";
import type { IdGenerator } from "../support/id_generator.js";
import { StaleRecordError } from "./stale_record_error.js";

/** Column names that `PgModel` manages automatically, when the table actually has them. */
type AutoManagedKey = "id" | "createdAt" | "updatedAt";

/**
 * Default upper bound on the number of values accepted by `listIn`/`groupedIn`/
 * `retrieveMany` (methods that pass a set of values to an `IN` clause). Set to 1000,
 * large enough not to break existing call sites (same default as `SQLiteModel`; can be
 * overridden via `PgModel`'s third constructor argument).
 */
const DEFAULT_MAX_IN_VALUES = 1000;

/**
 * Input type for `create`/`createMany`. Makes the `id`/`createdAt`/`updatedAt` columns
 * optional when the table has them (since the base class fills them in automatically).
 * For tables that don't have them, this transform is a no-op and other required columns
 * stay required (same contract as `SQLiteModel`'s `Creatable`).
 */
type Creatable<TTable extends PgTable> = Omit<TTable["$inferInsert"], AutoManagedKey> &
	Partial<Pick<TTable["$inferInsert"], Extract<keyof TTable["$inferInsert"], AutoManagedKey>>>;

/**
 * Derives a Postgres table's row type from `$inferSelect` (specific to `PgModel`; the
 * SQLite counterpart is `SQLiteModelRecord`).
 */
export type PgModelRecord<TTable extends PgTable> = TTable["$inferSelect"];

/**
 * Arguments for `PgModel#paginate`. The cursor is the primary key value of the last row
 * of the previous page, in the order given by `direction`. Defaults to `"asc"` when
 * `direction` is omitted (for backward compatibility).
 */
export type PgPaginateOptions<TPk extends PgColumn> = {
	cursor?: GetColumnData<TPk, "raw">;
	limit: number;
	direction?: "asc" | "desc";
	/** Optional filter condition, ANDed with the cursor condition. For search/scoped listings. */
	where?: SQL;
};

/** Return value of `PgModel#paginate`. */
export type PgPaginateResult<TTable extends PgTable, TPk extends PgColumn> = {
	rows: PgModelRecord<TTable>[];
	nextCursor: GetColumnData<TPk, "raw"> | null;
	hasMore: boolean;
};

/** Arguments for `PgModel#listPage`. */
export type PgListPageOptions = {
	where?: SQL;
	/** Sort columns, applied in array order. Defaults to primary key ascending when omitted or empty. */
	orderBy?: { column: PgColumn; direction: "asc" | "desc" }[];
	limit: number;
	offset?: number;
};

/** Conflict resolution for `PgModel#upsert`. `target` is the column(s) making up the UNIQUE constraint, `set` is what to update on conflict. */
export type PgUpsertConflict<TTable extends PgTable> = {
	target: PgColumn | PgColumn[];
	set: Partial<TTable["$inferInsert"]>;
};

export abstract class PgModel<
	TTable extends PgTable,
	TPk extends PgColumn,
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	constructor(
		protected readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly idGenerator: IdGenerator = new SnowflakeIdGenerator(),
		private readonly maxInValues: number = DEFAULT_MAX_IN_VALUES,
	) {}

	/** Target table. Declared by the subclass (e.g. `protected get table() { return items; }`). */
	protected abstract get table(): TTable;

	/** Primary key column. Declared by the subclass (e.g. `protected get primaryKey() { return items.id; }`). */
	protected abstract get primaryKey(): TPk;

	/**
	 * Internal helper for referring to `this.table` as `PgTable` (the concrete type with
	 * the `TTable` type parameter erased). pg-core's `.from()`/`.insert()`/`.update()`/
	 * `.delete()` have overloads keyed on the conditional type
	 * `TableLikeHasEmptySelection<T>` (`T extends Subquery`; confirmed in
	 * `node_modules/drizzle-orm/pg-core/query-builders/select.types.d.ts`), so passing an
	 * abstract type parameter `TTable extends PgTable` straight to Drizzle prevents this
	 * conditional type from resolving and causes a compile error (a pg-core-specific
	 * issue that doesn't occur in `SQLiteModel` since drizzle-orm/sqlite-core has no
	 * equivalent conditional-type overload). Introducing a concrete `PgTable`-typed
	 * variable lets TypeScript resolve the conditional type to its `false` branch, so
	 * every method uses this getter instead of `this.table` directly.
	 */
	private get pgTable(): PgTable {
		return this.table;
	}

	/** Fetches a single row by primary key. Returns `undefined` if it doesn't exist. */
	async retrieve(pk: GetColumnData<TPk, "raw">): Promise<PgModelRecord<TTable> | undefined> {
		const [row] = await this.db.select().from(this.pgTable).where(eq(this.primaryKey, pk)).limit(1);
		return row;
	}

	/**
	 * Fetches a single row by primary key while acquiring a row lock via
	 * `SELECT ... FOR UPDATE` (pessimistic locking). Signature and return type match
	 * `retrieve`.
	 *
	 * **A row lock only has meaning inside a transaction.** Call this through a
	 * transaction-bound instance obtained via `with(tx)`. Called outside a transaction
	 * (autocommit), the lock is released as soon as the statement finishes executing,
	 * so it can't prevent another transaction from interleaving before the following
	 * read/update.
	 *
	 * ```ts
	 * await db.transaction(async (tx) => {
	 *   const item = await items.with(tx).retrieveForUpdate(id);
	 *   if (!item) throw new Error("not found");
	 *   await items.with(tx).update(id, { count: item.count + 1 });
	 * });
	 * ```
	 *
	 * `SQLiteModel` has no equivalent method: SQLite has no row lock (`FOR UPDATE`);
	 * writes are locked at the database level instead. This is a deliberate case where
	 * the method vocabulary is asymmetric across dialects.
	 */
	async retrieveForUpdate(
		pk: GetColumnData<TPk, "raw">,
	): Promise<PgModelRecord<TTable> | undefined> {
		const [row] = await this.db
			.select()
			.from(this.pgTable)
			.where(eq(this.primaryKey, pk))
			.limit(1)
			.for("update");
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
	async retrieveBy(where: SQL | undefined): Promise<PgModelRecord<TTable> | undefined> {
		const [row] = await this.db.select().from(this.pgTable).where(where).limit(1);
		return row;
	}

	/**
	 * Returns every row matching `where` (all rows if `where` is omitted). There is no
	 * row limit, so on large tables this can load an unbounded result set into memory.
	 * Use `paginate` when the result set may be large.
	 */
	async list(where?: SQL): Promise<PgModelRecord<TTable>[]> {
		return this.db.select().from(this.pgTable).where(where);
	}

	/** Whether at least one row matches `where`. */
	async exists(where?: SQL): Promise<boolean> {
		const [row] = await this.db
			.select({ found: sql<number>`1` })
			.from(this.pgTable)
			.where(where)
			.limit(1);
		return row !== undefined;
	}

	/** Number of rows matching `where`. */
	async count(where?: SQL): Promise<number> {
		const [row] = await this.db.select({ value: countRows() }).from(this.pgTable).where(where);
		return row?.value ?? 0;
	}

	/** Returns only the values of the given column as an array (all rows if `where` is omitted). */
	async pluck<TColumn extends PgColumn>(
		column: TColumn,
		where?: SQL,
	): Promise<GetColumnData<TColumn>[]> {
		const rows = await this.db.select({ value: column }).from(this.pgTable).where(where);
		return rows.map((row) => row.value);
	}

	/**
	 * Returns every row whose `column` value matches one of `values`
	 * (`WHERE column IN (values)`; same contract as `SQLiteModel#listIn`). A vocabulary
	 * for bulk-fetching by a set of parent IDs/FKs, avoiding an N+1 pattern of calling
	 * `retrieve`/`list` in a loop (also the basis of `groupedIn`/`retrieveMany`). If
	 * `values` is an empty array, no query is issued and `[]` is returned (an empty
	 * `IN ()` is invalid SQL syntax). If `values.length` exceeds the third constructor
	 * argument `maxInValues` (default `1000`), no query is issued and this throws
	 * instead (a guard against unbounded `IN` clause expansion; use `paginate`'s
	 * `where` for large-scale filtering).
	 */
	async listIn<TColumn extends PgColumn>(
		column: TColumn,
		values: readonly GetColumnData<TColumn, "raw">[],
	): Promise<PgModelRecord<TTable>[]> {
		if (values.length === 0) return [];
		this.assertWithinMaxInValues(values.length);
		return this.db.select().from(this.pgTable).where(inArray(column, values));
	}

	/**
	 * Performs the same fetch as `listIn` but returns a `Map` grouped by the `column`
	 * value (same contract as `SQLiteModel#groupedIn`). A vocabulary for bulk-loading a
	 * "has many" relation without an N+1 pattern of calling `list` in a loop
	 * (`groupedIn(fkColumn, parentIds)` yields `parentId -> childRows[]`). A column
	 * value with no matching rows in `values` simply has no key in the map. Returns an
	 * empty map (no query issued) if `values` is empty.
	 *
	 * Since the grouping key is the value of a dynamic column (`column`), TypeScript
	 * cannot statically track it as a property name of `PgModelRecord<TTable>`, so it's
	 * read using the same technique as `paginate`'s `__cursor` (aliasing `column` as
	 * `__group` in the `select` and destructuring it back off). The `values.length`
	 * upper-bound guard is the same as `listIn` (throws once `maxInValues` is exceeded).
	 */
	async groupedIn<TColumn extends PgColumn>(
		column: TColumn,
		values: readonly GetColumnData<TColumn, "raw">[],
	): Promise<Map<GetColumnData<TColumn, "raw">, PgModelRecord<TTable>[]>> {
		const grouped = new Map<GetColumnData<TColumn, "raw">, PgModelRecord<TTable>[]>();
		if (values.length === 0) return grouped;
		this.assertWithinMaxInValues(values.length);

		const fetched = await this.db
			.select({ ...getTableColumns(this.table), __group: column })
			.from(this.pgTable)
			.where(inArray(column, values));

		for (const { __group, ...record } of fetched) {
			/** The structural reason `record` matches `PgModelRecord<TTable>` is the same as in `paginate`. */
			const row = record as PgModelRecord<TTable>;
			const bucket = grouped.get(__group);
			if (bucket) bucket.push(row);
			else grouped.set(__group, [row]);
		}
		return grouped;
	}

	/**
	 * Bulk-fetches by an array of primary keys and returns `Map<primaryKeyValue, row>`
	 * (same contract as `SQLiteModel#retrieveMany`). A vocabulary for bulk-loading a
	 * "belongs to" relation without an N+1 pattern of calling `retrieve` in a loop
	 * (`retrieveMany(parentIds)`). A primary key that doesn't exist simply has no key
	 * in the map. Returns an empty map (no query issued) if `pks` is empty. Duplicate
	 * primary keys still result in a single query. The `pks.length` upper-bound guard
	 * is the same as `listIn` (throws once `maxInValues` is exceeded).
	 */
	async retrieveMany(
		pks: readonly GetColumnData<TPk, "raw">[],
	): Promise<Map<GetColumnData<TPk, "raw">, PgModelRecord<TTable>>> {
		const result = new Map<GetColumnData<TPk, "raw">, PgModelRecord<TTable>>();
		if (pks.length === 0) return result;
		this.assertWithinMaxInValues(pks.length);

		const fetched = await this.db
			.select({ ...getTableColumns(this.table), __pk: this.primaryKey })
			.from(this.pgTable)
			.where(inArray(this.primaryKey, pks));

		for (const { __pk, ...record } of fetched) {
			result.set(__pk, record as PgModelRecord<TTable>);
		}
		return result;
	}

	/**
	 * Cursor-based pagination (same contract as `SQLiteModel#paginate`; `OFFSET` is
	 * avoided).
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
	}: PgPaginateOptions<TPk>): Promise<PgPaginateResult<TTable, TPk>> {
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
			.from(this.pgTable)
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
		 * `__cursor` alias removed, so it structurally matches `PgModelRecord<TTable>`,
		 * but TypeScript cannot statically track that a destructuring removal matches
		 * `$inferSelect`, so `as` is used only here (same reason as `SQLiteModel#paginate`).
		 */
		return { rows: rows as PgModelRecord<TTable>[], nextCursor, hasMore };
	}

	/**
	 * Offset-based pagination in arbitrary column order (same contract as
	 * `SQLiteModel#listPage`). Where `paginate` is cursor-based and fixed to primary key
	 * order, `listPage` trades that for the flexibility of sorting by any column and
	 * jumping straight to a given page number — the shape a column-sortable,
	 * numbered-page admin listing needs. Prefer `paginate` for large-scale, publicly
	 * listed data: a large `offset` still requires the database to scan and discard that
	 * many rows before returning results, so `listPage` is best suited to bounded,
	 * internal-facing listings (e.g. an admin panel) rather than deep pagination over
	 * unbounded public data.
	 *
	 * `orderBy` is applied in array order; when omitted or empty, rows are sorted by
	 * primary key ascending so results stay deterministic across calls. `offset` defaults
	 * to `0`.
	 */
	async listPage(options: PgListPageOptions): Promise<PgModelRecord<TTable>[]> {
		const orderBy =
			options.orderBy && options.orderBy.length > 0
				? options.orderBy.map((entry) =>
						entry.direction === "desc" ? desc(entry.column) : asc(entry.column),
					)
				: [asc(this.primaryKey)];
		return this.db
			.select()
			.from(this.pgTable)
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
	 * holding the numeric string returned by the `IdGenerator` (Snowflake by default;
	 * same contract as `SQLiteModel#create`).
	 */
	async create(input: Creatable<TTable>): Promise<PgModelRecord<TTable>> {
		const [row] = await this.db.insert(this.pgTable).values(this.withAutoFields(input)).returning();
		return row;
	}

	/** Bulk-creates multiple rows, generating a separate id for each. Passing an empty array is a no-op returning `[]`. */
	async createMany(inputs: Creatable<TTable>[]): Promise<PgModelRecord<TTable>[]> {
		if (inputs.length === 0) return [];
		const values = inputs.map((input) => this.withAutoFields(input));
		return this.db.insert(this.pgTable).values(values).returning();
	}

	/**
	 * Updates a single row by primary key. `updatedAt` (when present on the table) is
	 * always overwritten with the current time, regardless of what the caller passes.
	 * Returns `undefined` if the target row doesn't exist.
	 */
	async update(
		pk: GetColumnData<TPk, "raw">,
		patch: Partial<TTable["$inferInsert"]>,
	): Promise<PgModelRecord<TTable> | undefined> {
		const [row] = await this.db
			.update(this.pgTable)
			.set(this.withTouchedUpdatedAt(patch))
			.where(eq(this.primaryKey, pk))
			.returning();
		return row;
	}

	/**
	 * Bulk-updates every row matching `where` and returns the number of rows actually
	 * updated (same contract as `SQLiteModel#updateWhere`). Provides
	 * `WHERE status = 'unused'`-style optimistic locking as a first-class method.
	 * `updatedAt` is handled the same as `update`. `where` is typed `SQL | undefined`
	 * (required, not optional) for the same reason as `retrieveBy`.
	 *
	 * The count is not read from `db`'s raw execution result object (a driver-specific
	 * `rowCount`, etc.); it's the length of the row array returned by
	 * `.returning({ pk: this.primaryKey })` (Postgres supports UPDATE/DELETE ...
	 * RETURNING, typed via `PgUpdateBase#returning`, confirmed in
	 * `node_modules/drizzle-orm/pg-core/query-builders/update.d.ts`). This keeps `db`'s
	 * type independent from any driver-specific execution result type, so it works
	 * across drivers such as postgres-js/neon-http/pglite.
	 */
	async updateWhere(
		where: SQL | undefined,
		patch: Partial<TTable["$inferInsert"]>,
	): Promise<number> {
		const updated = await this.db
			.update(this.pgTable)
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
	 * `lockVersion` to `expectedVersion + 1` on success (same contract as
	 * `SQLiteModel#updateLocked`). `updatedAt` (when present on the table) is handled
	 * the same as `update`.
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
	): Promise<PgModelRecord<TTable>> {
		const lockVersion = this.lockVersionColumn();
		const nextPatch = {
			...this.withTouchedUpdatedAt(patch),
			lockVersion: expectedVersion + 1,
		} as Partial<TTable["$inferInsert"]>;
		const [row] = await this.db
			.update(this.pgTable)
			.set(nextPatch)
			.where(and(eq(this.primaryKey, pk), eq(lockVersion, expectedVersion)))
			.returning();
		if (!row) throw new StaleRecordError(getTableName(this.table), pk);
		return row;
	}

	/**
	 * Sets `deletedAt` to the current time (soft delete). Return value and the
	 * `updatedAt`-touching behavior follow `update`, and this delegates its
	 * implementation to `update` (same contract as `SQLiteModel#softDelete`). Returns
	 * `undefined` if the target row doesn't exist. Calling this on an already
	 * soft-deleted row is not special-cased; it simply overwrites `deletedAt` with a
	 * newer timestamp.
	 *
	 * Fetch methods like `list`/`retrieve` do not automatically exclude rows with a
	 * non-null `deletedAt` (an implicit global scope is deliberately not
	 * provided, per the "no magic" policy). Callers that want to exclude deleted rows
	 * must add `isNull(table.deletedAt)` to `where` explicitly.
	 */
	async softDelete(pk: GetColumnData<TPk, "raw">): Promise<PgModelRecord<TTable> | undefined> {
		this.assertDeletedAtColumn();
		return this.update(pk, { deletedAt: Date.now() } as Partial<TTable["$inferInsert"]>);
	}

	/** Resets `deletedAt` to `null` (undoes a soft delete). Contract and delegation target match `softDelete`. */
	async restore(pk: GetColumnData<TPk, "raw">): Promise<PgModelRecord<TTable> | undefined> {
		this.assertDeletedAtColumn();
		return this.update(pk, { deletedAt: null } as Partial<TTable["$inferInsert"]>);
	}

	/**
	 * Updates using `set` on conflict on `target` (the UNIQUE constraint column(s)),
	 * otherwise creates a new row from `input`. `updatedAt` is handled the same as
	 * `update`. pg-core's `onConflictDoUpdate` exists under the same name as the SQLite
	 * version (confirmed as `PgInsertOnConflictDoUpdateConfig` in
	 * `node_modules/drizzle-orm/pg-core/query-builders/insert.d.ts`; `target`'s type is
	 * `IndexColumn`, an alias for `PgColumn`).
	 */
	async upsert(
		input: Creatable<TTable>,
		conflict: PgUpsertConflict<TTable>,
	): Promise<PgModelRecord<TTable>> {
		const [row] = await this.db
			.insert(this.pgTable)
			.values(this.withAutoFields(input))
			.onConflictDoUpdate({ target: conflict.target, set: this.withTouchedUpdatedAt(conflict.set) })
			.returning();
		return row;
	}

	/** Updates only `updatedAt` to the current time. A no-op if the table has no `updatedAt` column. */
	async touch(pk: GetColumnData<TPk, "raw">): Promise<void> {
		if (!("updatedAt" in this.table)) return;
		await this.db
			.update(this.pgTable)
			.set(this.withTouchedUpdatedAt({}))
			.where(eq(this.primaryKey, pk));
	}

	/**
	 * Adds `delta` (default 1) to the given column, issuing SQL as
	 * `column = column + delta` (same reasoning as `SQLiteModel#increment` for using the
	 * raw-SQL path).
	 *
	 * The left-hand side of `SET` (the assignment target) must be an unqualified, bare
	 * column name in Postgres too (`SET "items"."count" = ...` is a syntax error),
	 * confirmed by executing against PGlite (`test/model/pg_model.test.ts`). Only the
	 * left side uses `sql.identifier(column.name)` to produce a bare identifier, while
	 * the right-hand side reference stays as `${column}` (table-qualified).
	 */
	async increment(pk: GetColumnData<TPk, "raw">, column: PgColumn, delta = 1): Promise<void> {
		await this.db.execute(
			sql`update ${this.table} set ${sql.identifier(column.name)} = ${column} + ${delta} where ${eq(this.primaryKey, pk)}`,
		);
	}

	/** Subtracts `delta` (default 1) from the given column. The sign-flipped counterpart of `increment`. */
	async decrement(pk: GetColumnData<TPk, "raw">, column: PgColumn, delta = 1): Promise<void> {
		await this.increment(pk, column, -delta);
	}

	/** Deletes a single row by primary key. Returns the deleted row (`undefined` if it didn't exist). */
	async delete(pk: GetColumnData<TPk, "raw">): Promise<PgModelRecord<TTable> | undefined> {
		const [row] = await this.db.delete(this.pgTable).where(eq(this.primaryKey, pk)).returning();
		return row;
	}

	/**
	 * Bulk-deletes every row matching `where` and returns the number of rows actually
	 * deleted (the DELETE counterpart of `updateWhere`, sharing the same `where`
	 * contract; same contract as `SQLiteModel#deleteWhere`). `where` is typed
	 * `SQL | undefined` (required, not optional) for the same reason as `retrieveBy`.
	 *
	 * **This is a hard delete** — it issues a real `DELETE` statement, unlike
	 * `softDelete`, which only sets `deletedAt`. `deleteWhere` does not auto-scope to
	 * non-deleted rows; the caller's `where` is authoritative, so callers that want to
	 * skip already soft-deleted rows must add that condition themselves (e.g.
	 * `isNull(table.deletedAt)`).
	 *
	 * The count is derived the same way as `updateWhere`: the length of the row array
	 * returned by `.returning({ pk: this.primaryKey })` (Postgres' DELETE also supports
	 * RETURNING, typed via `PgDeleteBase#returning`, confirmed in
	 * `node_modules/drizzle-orm/pg-core/query-builders/delete.d.ts`), for the same
	 * driver-independence reason given in `updateWhere`'s JSDoc.
	 */
	async deleteWhere(where: SQL | undefined): Promise<number> {
		const deleted = await this.db
			.delete(this.pgTable)
			.where(where)
			.returning({ pk: this.primaryKey });
		return deleted.length;
	}

	/**
	 * Returns a model instance of the same type bound to a transaction. Used in
	 * cross-model orchestration (the handlers layer) like
	 * `db.transaction(async (tx) => { const txBooks = books.with(tx); ... })` (same
	 * contract as `SQLiteModel#with`; pg-core's `PgTransaction` extends `PgDatabase`, so
	 * it can be accepted with the same type).
	 */
	with(tx: PgDatabase<TQueryResult, TSchema>): this {
		/**
		 * `this.constructor` refers to the subclass at runtime (e.g. `ItemModel`), but
		 * TypeScript cannot statically track `this`'s concrete constructor type.
		 * Assuming the subclass inherits `PgModel`'s constructor signature
		 * `(db, idGenerator?)` unchanged (i.e. it doesn't define its own constructor),
		 * `as` is used only here to make the constructor type explicit (same reason as
		 * `SQLiteModel#with`).
		 */
		const Ctor = this.constructor as new (
			db: PgDatabase<TQueryResult, TSchema>,
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
	 * value (same reason as `SQLiteModel#withAutoFields`).
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
	private lockVersionColumn(): PgColumn {
		if (!("lockVersion" in this.table)) {
			throw new Error(
				`PgModel#updateLocked: table "${getTableName(this.table)}" has no lockVersion column. ` +
					"Add a lockVersion column (integer, NOT NULL, initial value 0) to the table to use optimistic locking.",
			);
		}
		return (this.table as PgTable & { lockVersion: PgColumn }).lockVersion;
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
				`PgModel#softDelete: table "${getTableName(this.table)}" has no deletedAt column. ` +
					"Add a deletedAt column (bigint mode: number, nullable) to the table to use soft delete.",
			);
		}
	}

	/**
	 * Guard used by `listIn`/`groupedIn`/`retrieveMany` to check that the number of
	 * values passed to an `IN` clause doesn't exceed the third constructor argument
	 * `maxInValues`. Throws with a clear message if it's exceeded (same contract as
	 * `SQLiteModel#assertWithinMaxInValues`).
	 */
	private assertWithinMaxInValues(length: number): void {
		if (length > this.maxInValues) {
			throw new Error(
				`PgModel: number of values passed to IN clause (${length}) exceeds the limit (${this.maxInValues}). ` +
					"Use paginate(where) for large-scale filtering.",
			);
		}
	}
}
