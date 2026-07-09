/**
 * A `JobQueue` implementation that uses the RDB itself as the job queue. Useful when
 * you want enqueue/execution to complete entirely
 * within an app's existing SQLite (libSQL/Turso/D1), without needing external
 * middleware such as Cloudflare Queues. This is the producer side, paired with
 * `SQLiteDatabaseJobWorker` (`sqlite_database_job_worker.ts`).
 *
 * Injecting an arbitrary Drizzle (sqlite-core) table follows the same convention as
 * `SQLiteDatabaseKeyValueStore` (`kv/sqlite_database_key_value_store.ts`) and
 * `SQLiteDatabaseSessionStorage` (`session/sqlite_database_session_storage.ts`) — how
 * the column contract is accepted, typing via `AnySQLiteColumn`, and constructor
 * injection of db/table.
 *
 * **Parallel dialect implementations** (see `sqlite_model.ts`): the Postgres version is
 * implemented independently as `PgDatabaseJobQueue` in `pg_database_job_queue.ts`, and
 * the MySQL version as `MySqlDatabaseJobQueue` in `mysql_database_job_queue.ts` (no
 * common abstraction is built, since Drizzle's type system is parallel rather than
 * shared across dialects — only method vocabulary and algorithm are kept consistent).
 *
 * Both `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family driver, but
 * the type itself is driver-independent) and `table` are constructor-injected.
 * `table`'s required column contract (`SQLiteJobRecordTable`):
 * - `id` (TEXT NOT NULL, expected PRIMARY KEY)
 * - `name` (TEXT NOT NULL): the job name (must match the registration key in `JobRegistry`)
 * - `payload` (TEXT NOT NULL): the payload string produced by `JSON.stringify`
 * - `runAt` (INTEGER NOT NULL): scheduled execution time (epoch ms)
 * - `priority` (INTEGER NOT NULL): priority; lower is higher priority (default 0)
 * - `attempts` (INTEGER NOT NULL): number of execution attempts (starts at 0)
 * - `lockedAt` (INTEGER, nullable): time a worker claimed the row (epoch ms); `null`
 *   means unclaimed
 * - `failedAt` (INTEGER, nullable): time of the final failure; rows with a non-null
 *   value are never retried by `SQLiteDatabaseJobWorker`
 * - `lastError` (TEXT, nullable): the most recent error content
 * - `createdAt` (INTEGER NOT NULL): time the job was enqueued (epoch ms)
 *
 * ID generation follows the same convention as `SQLiteModel` (default
 * `SnowflakeIdGenerator`; the `id` column is assumed to be a string type).
 *
 * `db`'s type is genericized over `TSchema` for the same reason as `SQLiteModel` (since
 * `BaseSQLiteDatabase`'s schema type parameter is invariant, this lets a `db` created
 * with a concrete schema, e.g. `drizzle(client, { schema })`, be accepted as-is. The
 * `db` returned by `createTestDb` — `src/test/db.ts` — has this shape).
 */
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, SQLiteTable, TableConfig } from "drizzle-orm/sqlite-core";
import type { Job } from "./job.js";
import type { EnqueueOptions } from "./job_queue.js";
import { assertValidEnqueueOptions, JobQueue } from "./job_queue.js";
import type { IdGenerator } from "../support/id_generator.js";
import { SnowflakeIdGenerator } from "../support/id_generator.js";

/**
 * Type of a Drizzle table with the columns required by `SQLiteDatabaseJobQueue`/
 * `SQLiteDatabaseJobWorker`. Uses `AnySQLiteColumn` (same idea as
 * `SQLiteKeyValueRecordTable` etc.), so the table name and other column layout are
 * unconstrained.
 */
export type SQLiteJobRecordTable = SQLiteTable<TableConfig> & {
	id: AnySQLiteColumn<{ data: string; notNull: true }>;
	name: AnySQLiteColumn<{ data: string; notNull: true }>;
	payload: AnySQLiteColumn<{ data: string; notNull: true }>;
	runAt: AnySQLiteColumn<{ data: number; notNull: true }>;
	priority: AnySQLiteColumn<{ data: number; notNull: true }>;
	attempts: AnySQLiteColumn<{ data: number; notNull: true }>;
	lockedAt: AnySQLiteColumn<{ data: number; notNull: false }>;
	failedAt: AnySQLiteColumn<{ data: number; notNull: false }>;
	lastError: AnySQLiteColumn<{ data: string; notNull: false }>;
	createdAt: AnySQLiteColumn<{ data: number; notNull: true }>;
};

export type SQLiteDatabaseJobQueueOptions = {
	/** `IdGenerator` used for id generation. Defaults to `SnowflakeIdGenerator` (same convention as `SQLiteModel`). */
	idGenerator?: IdGenerator;
};

export class SQLiteDatabaseJobQueue<
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends JobQueue {
	private readonly idGenerator: IdGenerator;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: SQLiteJobRecordTable,
		options: SQLiteDatabaseJobQueueOptions = {},
	) {
		super();
		this.idGenerator = options.idGenerator ?? new SnowflakeIdGenerator();
	}

	/**
	 * JSON-stringifies `payload` and inserts a single row. `options.delaySeconds`
	 * (default 0) sets `runAt` that many seconds into the future. `options.priority`
	 * (default 0) is reflected in claim order (lower is higher priority). `payload`'s
	 * JSON-serializable contract is the same as the `Job` base (`job.ts`).
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
 * Factory that returns a default schema satisfying `SQLiteJobRecordTable`. The table
 * name can be changed via the `tableName` argument (default `"jobs"`). Migration
 * generation is the application's responsibility via drizzle-kit (this factory only
 * provides the schema definition).
 */
export const sqliteJobsTable = (tableName = "jobs") =>
	sqliteTable(
		tableName,
		{
			id: text("id").primaryKey(),
			name: text("name").notNull(),
			payload: text("payload").notNull(),
			runAt: integer("run_at").notNull(),
			priority: integer("priority").notNull(),
			attempts: integer("attempts").notNull(),
			lockedAt: integer("locked_at"),
			failedAt: integer("failed_at"),
			lastError: text("last_error"),
			createdAt: integer("created_at").notNull(),
		},
		(t) => [
			/**
			 * Composite index for the claim-candidate SELECT
			 * (`SQLiteDatabaseJobWorker#claim`), which scans with
			 * `WHERE failed_at IS NULL AND run_at <= now ... ORDER BY priority, run_at`.
			 */
			index(`${tableName}_priority_run_at_idx`).on(t.priority, t.runAt),
		],
	) satisfies SQLiteJobRecordTable;
