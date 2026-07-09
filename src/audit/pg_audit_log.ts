/**
 * Postgres (pg-core) implementation of `AuditLog`, which records audit log entries
 * one row at a time in an RDB. It parallel-implements the same contract (column
 * contract, algorithm, JSDoc structure) as `SQLiteAuditLog` in `sqlite_audit_log.ts`
 * for pg-core (dialect-specific parallel implementation; see the module JSDoc of
 * `pg_model.ts`).
 *
 * Injecting an arbitrary table over Drizzle (pg-core) follows the same convention as
 * `PgDatabaseJobQueue` in `jobs/pg_database_job_queue.ts` and
 * `PgDatabaseKeyValueStore` in `kv/pg_database_key_value_store.ts` (accepting a
 * column contract, typing via `AnyPgColumn`, constructor injection of db/table).
 *
 * Both `db` (`PgDatabase<TQueryResult, TSchema>`; see the module JSDoc of
 * `pg_model.ts` for why `TQueryResult` is promoted to a class type parameter) and
 * `table` are constructor-injected. The column contract that `table` must satisfy
 * (`PgAuditRecordTable`) has the same column names and meanings as
 * `SQLiteAuditRecordTable`, but `createdAt` (a column storing an epoch-ms value) uses
 * `bigint(..., { mode: "number" })` because a 32-bit `integer` would go out of range
 * (same reason as `createdAt`/`updatedAt` in `pg_model.ts`):
 * - `id` (TEXT NOT NULL, expected PRIMARY KEY)
 * - `actor` (TEXT NOT NULL): the entity that performed the operation (e.g. a user ID)
 * - `action` (TEXT NOT NULL): the kind of operation (e.g. `"user.update"`; a vocabulary the app defines)
 * - `target` (TEXT NOT NULL): the target of the operation (e.g. a target resource ID)
 * - `changes` (TEXT, nullable): the change content as a `JSON.stringify`-ed string; `null` if not specified
 * - `createdAt` (bigint mode number, NOT NULL): the time recorded (epoch ms)
 *
 * `id` generation follows the same convention as `PgModel` (defaults to
 * `SnowflakeIdGenerator`; the `id` column assumes a string type).
 *
 * Important: automatic wiring to model saves etc. (e.g. callbacks from save hooks) is
 * rejected by design. Calling `record` is an explicit responsibility of the app; this
 * class is never invoked implicitly.
 */
import { and, desc, eq } from "drizzle-orm";
import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import type {
	AnyPgColumn,
	PgDatabase,
	PgQueryResultHKT,
	PgTable,
	TableConfig,
} from "drizzle-orm/pg-core";
import type { IdGenerator } from "../support/id_generator.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";

/** Query conditions passed to `PgAuditLog#list`. All are optional; only the specified ones are ANDed together. */
export type PgAuditLogListOptions = {
	actor?: string;
	action?: string;
	target?: string;
	/** Maximum number of rows to return. Defaults to 100. */
	limit?: number;
};

/**
 * The type of a Drizzle table with the columns required by `PgAuditLog`. Uses
 * `AnyPgColumn` (the same idea as `PgJobRecordTable` etc.) and does not care about
 * the table name or other column layout.
 */
export type PgAuditRecordTable = PgTable<TableConfig> & {
	id: AnyPgColumn<{ data: string; notNull: true }>;
	actor: AnyPgColumn<{ data: string; notNull: true }>;
	action: AnyPgColumn<{ data: string; notNull: true }>;
	target: AnyPgColumn<{ data: string; notNull: true }>;
	changes: AnyPgColumn<{ data: string; notNull: false }>;
	createdAt: AnyPgColumn<{ data: number; notNull: true }>;
};

/** Options for constructing a `PgAuditLog`. */
export type PgAuditLogOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `PgModel`). */
	idGenerator?: IdGenerator;
};

/** An audit log entry passed to `PgAuditLog#record`. `changes` must be a JSON-serializable value. */
export type PgAuditLogEntry = {
	actor: string;
	action: string;
	target: string;
	changes?: unknown;
};

/**
 * Append-only audit log recorder backed by a Drizzle pg-core table.
 */
export class PgAuditLog<
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly idGenerator: IdGenerator;

	constructor(
		private readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly table: PgAuditRecordTable,
		options: PgAuditLogOptions = {},
	) {
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * Inserts a single audit log row. `changes` is JSON-stringified before storage, or
	 * stored as `null` when not specified (same algorithm as `SQLiteAuditLog#record`).
	 * Calling this is an explicit responsibility of the app; it is never invoked
	 * automatically from model saves etc. (rejected by design).
	 */
	async record(entry: PgAuditLogEntry): Promise<void> {
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
	async list(options: PgAuditLogListOptions = {}) {
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
 * Factory that returns a default schema satisfying `PgAuditRecordTable`. The table
 * name can be changed via the `tableName` argument (defaults to `"audits"`).
 * Migration generation is left to the app via drizzle-kit (this factory only
 * provides the schema definition).
 */
export const pgAuditsTable = (tableName = "audits") =>
	pgTable(
		tableName,
		{
			id: text("id").primaryKey(),
			actor: text("actor").notNull(),
			action: text("action").notNull(),
			target: text("target").notNull(),
			changes: text("changes"),
			createdAt: bigint("created_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/** Index for `ORDER BY created_at DESC, id DESC` in `list`. */
			index(`${tableName}_created_at_idx`).on(t.createdAt),
		],
	) satisfies PgAuditRecordTable;
