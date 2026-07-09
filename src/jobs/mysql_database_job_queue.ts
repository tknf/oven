/**
 * MySQL (mysql-core) version of a `JobQueue` implementation that uses the RDB itself as
 * the job queue. A parallel dialect implementation
 * of `sqlite_database_job_queue.ts`'s `SQLiteDatabaseJobQueue`, sharing the same
 * contract (column contract, algorithm, JSDoc structure) ported to mysql-core (see the
 * "parallel dialect implementations" note in `mysql_model.ts`'s module JSDoc). This is
 * the producer side, paired with `MySqlDatabaseJobWorker` (`mysql_database_job_worker.ts`).
 *
 * Injecting an arbitrary Drizzle (mysql-core) table follows the same convention as
 * `MySqlDatabaseKeyValueStore` (`kv/mysql_database_key_value_store.ts`) and
 * `MySqlDatabaseSessionStorage` (`session/mysql_database_session_storage.ts`) — how the
 * column contract is accepted, typing via `AnyMySqlColumn`, and constructor injection of
 * db/table.
 *
 * Both `db` (`MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>` — see
 * `mysql_model.ts`'s module JSDoc for why both are promoted to class type parameters)
 * and `table` are constructor-injected. `table`'s required column contract
 * (`MySqlJobRecordTable`) has the same column names and meaning as
 * `SQLiteJobRecordTable`, but `runAt`/`lockedAt`/`failedAt`/`createdAt` (columns that
 * store epoch ms) would be out of range for a 32-bit `int`, so `bigint(...,
 * { mode: "number" })` is used instead (same reasoning as `createdAt`/`updatedAt` in
 * `mysql_model.ts`):
 * - `id` (VARCHAR NOT NULL, expected PRIMARY KEY)
 * - `name` (VARCHAR NOT NULL): the job name (must match the registration key in `JobRegistry`)
 * - `payload` (TEXT/VARCHAR NOT NULL): the payload string produced by `JSON.stringify`
 * - `runAt` (bigint mode number, NOT NULL): scheduled execution time (epoch ms)
 * - `priority` (INT NOT NULL): priority; lower is higher priority (default 0; kept as
 *   `int` since 32 bits is enough)
 * - `attempts` (INT NOT NULL): number of execution attempts (starts at 0; kept as `int`
 *   since 32 bits is enough)
 * - `lockedAt` (bigint mode number, nullable): time a worker claimed the row (epoch ms);
 *   `null` means unclaimed
 * - `failedAt` (bigint mode number, nullable): time of the final failure; rows with a
 *   non-null value are never retried by `MySqlDatabaseJobWorker`
 * - `lastError` (TEXT/VARCHAR, nullable): the most recent error content
 * - `createdAt` (bigint mode number, NOT NULL): time the job was enqueued (epoch ms)
 *
 * ID generation follows the same convention as `MySqlModel` (default
 * `SnowflakeIdGenerator`; the `id` column is assumed to be a string type).
 */
import { bigint, index, int, mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import type {
	AnyMySqlColumn,
	MySqlDatabase,
	MySqlQueryResultHKT,
	MySqlTable,
	PreparedQueryHKTBase,
	TableConfig,
} from "drizzle-orm/mysql-core";
import type { Job } from "./job.js";
import type { EnqueueOptions } from "./job_queue.js";
import { assertValidEnqueueOptions, JobQueue } from "./job_queue.js";
import type { IdGenerator } from "../support/id_generator.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";

/**
 * Type of a Drizzle table with the columns required by `MySqlDatabaseJobQueue`/
 * `MySqlDatabaseJobWorker`. Uses `AnyMySqlColumn` (same idea as
 * `MySqlKeyValueRecordTable` etc.), so the table name and other column layout are
 * unconstrained.
 */
export type MySqlJobRecordTable = MySqlTable<TableConfig> & {
	id: AnyMySqlColumn<{ data: string; notNull: true }>;
	name: AnyMySqlColumn<{ data: string; notNull: true }>;
	payload: AnyMySqlColumn<{ data: string; notNull: true }>;
	runAt: AnyMySqlColumn<{ data: number; notNull: true }>;
	priority: AnyMySqlColumn<{ data: number; notNull: true }>;
	attempts: AnyMySqlColumn<{ data: number; notNull: true }>;
	lockedAt: AnyMySqlColumn<{ data: number; notNull: false }>;
	failedAt: AnyMySqlColumn<{ data: number; notNull: false }>;
	lastError: AnyMySqlColumn<{ data: string; notNull: false }>;
	createdAt: AnyMySqlColumn<{ data: number; notNull: true }>;
};

export type MySqlDatabaseJobQueueOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `MySqlModel`). */
	idGenerator?: IdGenerator;
};

export class MySqlDatabaseJobQueue<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends JobQueue {
	private readonly idGenerator: IdGenerator;

	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>,
		private readonly table: MySqlJobRecordTable,
		options: MySqlDatabaseJobQueueOptions = {},
	) {
		super();
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * JSON-stringifies `payload` and inserts a single row. `options.delaySeconds`
	 * (default 0) sets `runAt` that many seconds into the future. `options.priority`
	 * (default 0) is reflected in claim order (lower is higher priority). `payload`'s
	 * JSON-serializable contract is the same as the `Job` base (`job.ts`) — this is the
	 * same algorithm as `SQLiteDatabaseJobQueue#enqueue`.
	 */
	async enqueue<TPayload>(
		job: Job<TPayload>,
		payload: TPayload,
		options?: EnqueueOptions,
	): Promise<void> {
		assertValidEnqueueOptions(options);

		const now = Date.now();
		await this.db.insert(this.table).values({
			id: this.idGenerator.generate(),
			name: job.name,
			payload: JSON.stringify(payload),
			runAt: now + (options?.delaySeconds ?? 0) * 1000,
			priority: options?.priority ?? 0,
			attempts: 0,
			lockedAt: null,
			failedAt: null,
			lastError: null,
			createdAt: now,
		});
	}
}

/**
 * Factory that returns a default schema satisfying `MySqlJobRecordTable`. The table
 * name can be changed via the `tableName` argument (default `"jobs"`). Migration
 * generation is the application's responsibility via drizzle-kit (this factory only
 * provides the schema definition).
 */
export const mysqlJobsTable = (tableName = "jobs") =>
	mysqlTable(
		tableName,
		{
			id: varchar("id", { length: 255 }).primaryKey(),
			name: varchar("name", { length: 255 }).notNull(),
			payload: text("payload").notNull(),
			runAt: bigint("run_at", { mode: "number" }).notNull(),
			priority: int("priority").notNull(),
			attempts: int("attempts").notNull(),
			lockedAt: bigint("locked_at", { mode: "number" }),
			failedAt: bigint("failed_at", { mode: "number" }),
			lastError: text("last_error"),
			createdAt: bigint("created_at", { mode: "number" }).notNull(),
		},
		(t) => [
			/**
			 * Composite index for the claim-candidate SELECT
			 * (`MySqlDatabaseJobWorker#claim`), which scans with
			 * `WHERE failed_at IS NULL AND run_at <= now ... ORDER BY priority, run_at`.
			 */
			index(`${tableName}_priority_run_at_idx`).on(t.priority, t.runAt),
		],
	) satisfies MySqlJobRecordTable;
