/**
 * SQLite (sqlite-core) implementation of `AuditLog`, which records audit log entries
 * one row at a time in an RDB. Leaves an append-only record of who (`actor`), did
 * what (`action`), to what (`target`), and what changed (`changes`). Useful when you
 * want recording to be completed with only the SQLite (libSQL/Turso/D1) the app
 * already has, without requiring external middleware such as Cloudflare KV/R2.
 *
 * Injecting an arbitrary table over Drizzle (sqlite-core) follows the same
 * convention as `SQLiteDatabaseJobQueue` in `jobs/sqlite_database_job_queue.ts` and
 * `SQLiteDatabaseKeyValueStore` in `kv/sqlite_database_key_value_store.ts`
 * (accepting a column contract, typing via `AnySQLiteColumn`, constructor injection
 * of db/table).
 *
 * **Dialect-specific parallel implementation** (see `sqlite_model.ts`): the Postgres
 * version is implemented independently as `PgAuditLog` in `pg_audit_log.ts`, and the
 * MySQL version as `MySqlAuditLog` in `mysql_audit_log.ts` (no common abstraction is
 * created because Drizzle's type system is parallel across dialects; only the method
 * vocabulary and algorithm are shared).
 *
 * Both `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family driver,
 * but the type itself is driver-agnostic) and `table` are constructor-injected. The
 * column contract that `table` must satisfy (`SQLiteAuditRecordTable`):
 * - `id` (TEXT NOT NULL, expected PRIMARY KEY)
 * - `actor` (TEXT NOT NULL): the entity that performed the operation (e.g. a user ID)
 * - `action` (TEXT NOT NULL): the kind of operation (e.g. `"user.update"`; a vocabulary the app defines)
 * - `target` (TEXT NOT NULL): the target of the operation (e.g. a target resource ID)
 * - `changes` (TEXT, nullable): the change content as a `JSON.stringify`-ed string; `null` if not specified
 * - `createdAt` (INTEGER NOT NULL): the time recorded (epoch ms)
 *
 * `id` generation follows the same convention as `SQLiteModel` (defaults to
 * `SnowflakeIdGenerator`; the `id` column assumes a string type).
 *
 * Important: automatic wiring to model saves etc. (e.g. callbacks from save hooks) is
 * rejected by design. Calling `record` is an explicit responsibility of the app; this
 * class is never invoked implicitly.
 *
 * The type of `db` is made generic over `TSchema` for the same reason as
 * `SQLiteModel` (since `BaseSQLiteDatabase`'s schema type parameter is invariant, this
 * lets it accept a `db` built by passing a concrete schema, e.g.
 * `drizzle(client, { schema })`, as-is. The `db` returned by `createTestDb`
 * (`src/test/db.ts`) has this shape).
 */
import { and, desc, eq } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, SQLiteTable, TableConfig } from "drizzle-orm/sqlite-core";
import type { IdGenerator } from "../support/id_generator.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";

/** Query conditions passed to `SQLiteAuditLog#list`. All are optional; only the specified ones are ANDed together. */
export type SQLiteAuditLogListOptions = {
	actor?: string;
	action?: string;
	target?: string;
	/** Maximum number of rows to return. Defaults to 100. */
	limit?: number;
};

/**
 * The type of a Drizzle table with the columns required by `SQLiteAuditLog`. Uses
 * `AnySQLiteColumn` (the same idea as `SQLiteJobRecordTable` etc.) and does not care
 * about the table name or other column layout.
 */
export type SQLiteAuditRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: string; notNull: true }>;
	actor: AnySQLiteColumn<{ data: string; notNull: true }>;
	action: AnySQLiteColumn<{ data: string; notNull: true }>;
	target: AnySQLiteColumn<{ data: string; notNull: true }>;
	changes: AnySQLiteColumn<{ data: string; notNull: false }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

/** Options for constructing a `SQLiteAuditLog`. */
export type SQLiteAuditLogOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `SQLiteModel`). */
	idGenerator?: IdGenerator;
};

/** An audit log entry passed to `SQLiteAuditLog#record`. `changes` must be a JSON-serializable value. */
export type SQLiteAuditLogEntry = {
	actor: string;
	action: string;
	target: string;
	changes?: unknown;
};

/**
 * Append-only audit log recorder backed by a Drizzle sqlite-core table.
 */
export class SQLiteAuditLog<TSchema extends Record<string, unknown> = Record<string, never>> {
	private readonly idGenerator: IdGenerator;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: SQLiteAuditRecordTable,
		options: SQLiteAuditLogOptions = {},
	) {
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * Inserts a single audit log row. `changes` is JSON-stringified before storage, or
	 * stored as `null` when not specified. Calling this is an explicit responsibility
	 * of the app; it is never invoked automatically from model saves etc. (rejected by
	 * design).
	 */
	async record(entry: SQLiteAuditLogEntry): Promise<void> {
		await this.db.insert(this.table).values({
			id: this.idGenerator.generate(),
			actor: entry.actor,
			action: entry.action,
			target: entry.target,
			changes: entry.changes === undefined ? null : JSON.stringify(entry.changes),
			createdAt: Date.now(),
		});
	}

	/**
	 * Queries audit log entries (for the AdminPanel audit log viewer).
	 * `actor`/`action`/`target` are all optional; only the specified ones are ANDed
	 * together (unspecified ones are not added as a condition, and no `where` clause is
	 * added if none are specified). Returns up to `limit` (default 100) rows ordered by
	 * `createdAt` descending, with `id` descending as a tiebreaker (`id` is generated
	 * via Snowflake, so it matches chronological order). No update/delete API is added
	 * (this is an append-only recording layer by design).
	 */
	async list(options: SQLiteAuditLogListOptions = {}) {
		const { actor, action, target, limit = 100 } = options;
		const conditions = [
			actor !== undefined ? eq(this.table.actor, actor) : undefined,
			action !== undefined ? eq(this.table.action, action) : undefined,
			target !== undefined ? eq(this.table.target, target) : undefined,
		].filter((condition) => condition !== undefined);

		return this.db
			.select()
			.from(this.table)
			.where(conditions.length > 0 ? and(...conditions) : undefined)
			.orderBy(desc(this.table.createdAt), desc(this.table.id))
			.limit(limit);
	}
}

/**
 * Factory that returns a default schema satisfying `SQLiteAuditRecordTable`. The
 * table name can be changed via the `tableName` argument (defaults to `"audits"`).
 * Migration generation is left to the app via drizzle-kit (this factory only
 * provides the schema definition).
 */
export const sqliteAuditsTable = (tableName = "audits") =>
	sqliteTable(
		tableName,
		{
			id: text("id").primaryKey(),
			actor: text("actor").notNull(),
			action: text("action").notNull(),
			target: text("target").notNull(),
			changes: text("changes"),
			createdAt: integer("created_at").notNull(),
		},
		(t) => [
			/** Index for `ORDER BY created_at DESC, id DESC` in `list`. */
			index(`${tableName}_created_at_idx`).on(t.createdAt),
		],
	) satisfies SQLiteAuditRecordTable;
