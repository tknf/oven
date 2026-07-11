/**
 * Ready-made `Job` that garbage-collects expired rows from one or more
 * Drizzle (sqlite-core) tables shaped like the DB-backed `KeyValueStore`
 * (`kv/sqlite_database_key_value_store.ts`) and `SessionStorage`
 * (`session/sqlite_database_session_storage.ts`) families. Those stores only
 * delete an expired row incidentally, on the next `get` that happens to hit
 * it (see their module JSDoc) — nothing actively sweeps rows nobody reads
 * again, so this job fills that gap without adding GC to the stores
 * themselves.
 *
 * **Parallel dialect implementation** (see `sqlite_model.ts`): the Postgres
 * version is implemented independently as `PgPruneExpiredRecordsJob` in
 * `pg_prune_expired_records_job.ts`, and the MySQL version as
 * `MySqlPruneExpiredRecordsJob` in `mysql_prune_expired_records_job.ts` (no
 * shared abstraction is introduced, since Drizzle's type system runs in
 * parallel across dialects — only the vocabulary and algorithm are kept
 * consistent).
 *
 * **Target shape**: each entry in `targets` names one table to sweep via
 * `table` plus two column references from that same table — `pkColumn`
 * (the primary key, used to identify and delete matched rows) and
 * `expiresAtColumn` (the expiry column, epoch ms). Column references are
 * accepted directly rather than fixed column names, because the primary key
 * is named differently across the two families this job is meant for (`key`
 * for `SQLiteKeyValueRecordTable`, `id` for `SQLiteSessionRecordTable`).
 * `expiresAtColumn` is read generically (no `notNull` constraint), so both
 * the KV family's nullable `expiresAt` (`null` = never expires) and the
 * session family's `NOT NULL expiresAt` are accepted as-is; a row is only
 * considered expired when the column holds a non-null value that has
 * already passed.
 *
 * **Batch deletion algorithm**: `DELETE ... LIMIT` is not portable across
 * SQLite/Postgres/MySQL, so each target is swept by repeating "SELECT up to
 * `batchSize` expired primary keys, then `DELETE ... WHERE pk IN (...) AND
 * <still expired>`" until a batch comes back with fewer than `batchSize` rows
 * (nothing left to prune) or `maxBatches` is reached (a hard cap so one
 * `perform()` call cannot run unboundedly against a table with a very large
 * backlog of expired rows). The DELETE re-checks the same expiry condition
 * as the SELECT (against the same captured `now`, not a fresh one) rather
 * than trusting the selected primary keys alone: both `SQLiteDatabaseKeyValueStore.set`
 * and `SQLiteDatabaseSessionStorage.commit` renew a row in place (a
 * PK-preserving upsert that extends `expiresAt`), so a row selected as
 * expired can be renewed by the time the DELETE runs; without the repeated
 * check, that renewal would be silently discarded.
 *
 * `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family
 * driver, though the type itself is driver-independent) and `targets` are
 * constructor-injected, following the same convention as
 * `SQLiteDatabaseKeyValueStore`/`SQLiteDatabaseJobQueue`.
 */
import { and, inArray, isNotNull, lte } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn, SQLiteTable, TableConfig } from "drizzle-orm/sqlite-core";
import { Job } from "./job.js";

/** One table to sweep for expired rows, plus the columns needed to find and delete them (see module doc). */
export type SQLitePruneTarget = {
	/** The table containing expiring rows to prune. */
	table: SQLiteTable<TableConfig>;
	/** Primary key column of `table`, used to select candidates and to delete them by `IN`. */
	pkColumn: AnySQLiteColumn<{ data: string; notNull: true }>;
	/** Expiry column of `table` (epoch ms). A `null` value means "never expires" and is never pruned. */
	expiresAtColumn: AnySQLiteColumn<{ data: number }>;
};

export type SQLitePruneExpiredRecordsJobOptions = {
	/** Job name. Defaults to `"oven:prune_expired_records"`. */
	name?: string;
	/** Maximum rows selected (and deleted) per round-trip, per target. Default 500. */
	batchSize?: number;
	/** Maximum number of batches processed per target, per `perform()` call. Default 1000 (a backstop against an unbounded loop; a backlog larger than `batchSize * maxBatches` is cleared over subsequent runs). */
	maxBatches?: number;
};

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAX_BATCHES = 1000;

/**
 * `Job` that deletes expired rows from `targets` when it runs. Takes no
 * meaningful payload (`Record<string, never>`, i.e. `{}`) so it can be
 * enqueued through any `JobQueue` adapter — including the JSON-serializing
 * DB-backed and Cloudflare Queues transports — without a special case; in
 * practice it is usually invoked directly (`job.perform({})`) from a
 * `Schedule` entry or a `scheduled` handler rather than enqueued (see
 * `docs/jobs.md`).
 */
export class SQLitePruneExpiredRecordsJob<
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends Job<Record<string, never>> {
	readonly name: string;
	private readonly batchSize: number;
	private readonly maxBatches: number;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly targets: readonly SQLitePruneTarget[],
		options: SQLitePruneExpiredRecordsJobOptions = {},
	) {
		super();
		this.name = options.name ?? "oven:prune_expired_records";
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.maxBatches = options.maxBatches ?? DEFAULT_MAX_BATCHES;
	}

	/** Sweeps every target in `targets`, in order, deleting its expired rows in batches (see module doc). */
	async perform(_payload: Record<string, never> = {}): Promise<void> {
		for (const target of this.targets) {
			await this.pruneTarget(target);
		}
	}

	/** Repeats select-then-delete for a single target until it is caught up or `maxBatches` is reached. */
	private async pruneTarget(target: SQLitePruneTarget): Promise<void> {
		const now = Date.now();
		const isExpired = and(isNotNull(target.expiresAtColumn), lte(target.expiresAtColumn, now));

		for (let batch = 0; batch < this.maxBatches; batch += 1) {
			const rows = await this.db
				.select({ pk: target.pkColumn })
				.from(target.table)
				.where(isExpired)
				.limit(this.batchSize);
			if (rows.length === 0) return;

			await this.db.delete(target.table).where(
				and(
					inArray(
						target.pkColumn,
						rows.map((row) => row.pk),
					),
					isExpired,
				),
			);

			if (rows.length < this.batchSize) return;
		}
	}
}
