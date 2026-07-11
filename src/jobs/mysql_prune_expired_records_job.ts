/**
 * MySQL (mysql-core) version of a `Job` that garbage-collects expired rows
 * from one or more Drizzle tables shaped like the DB-backed `KeyValueStore`
 * (`kv/mysql_database_key_value_store.ts`) and `SessionStorage`
 * (`session/mysql_database_session_storage.ts`) families. A parallel
 * dialect implementation of `sqlite_prune_expired_records_job.ts`'s
 * `SQLitePruneExpiredRecordsJob`, sharing the same contract (target shape,
 * batch deletion algorithm, JSDoc structure) ported to mysql-core (see the
 * "parallel dialect implementation" note in `mysql_model.ts`'s module
 * JSDoc). See that file's module JSDoc for why this job exists and the
 * rationale behind the batch deletion algorithm.
 *
 * `db` (`MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>` — both
 * type parameters are promoted onto the class; see `mysql_model.ts`'s
 * module JSDoc) and `targets` are constructor-injected. Unlike
 * `MySqlDatabaseJobWorker` (which needs `affectedRows` off a raw
 * mysql2 result to detect a claim race — see `mysql_model.ts`'s "handling
 * the lack of RETURNING support" note), this job never depends on a
 * dialect-specific result shape: candidates are found with a plain
 * `SELECT ... LIMIT` and removed with `DELETE ... WHERE pk IN (...)`, so
 * the same select-then-delete algorithm as the SQLite/Postgres versions
 * applies unchanged.
 */
import { and, inArray, isNotNull, lte } from "drizzle-orm";
import type {
	AnyMySqlColumn,
	MySqlDatabase,
	MySqlQueryResultHKT,
	MySqlTable,
	PreparedQueryHKTBase,
	TableConfig,
} from "drizzle-orm/mysql-core";
import { Job } from "./job.js";

/** One table to sweep for expired rows, plus the columns needed to find and delete them (see `sqlite_prune_expired_records_job.ts`'s module doc). */
export type MySqlPruneTarget = {
	/** The table containing expiring rows to prune. */
	table: MySqlTable<TableConfig>;
	/** Primary key column of `table`, used to select candidates and to delete them by `IN`. */
	pkColumn: AnyMySqlColumn<{ data: string; notNull: true }>;
	/** Expiry column of `table` (epoch ms). A `null` value means "never expires" and is never pruned. */
	expiresAtColumn: AnyMySqlColumn<{ data: number }>;
};

export type MySqlPruneExpiredRecordsJobOptions = {
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
 * meaningful payload (`Record<string, never>`, i.e. `{}`) — see the module
 * JSDoc in `sqlite_prune_expired_records_job.ts` for why, and for the
 * intended "invoke directly from a `Schedule` entry" usage.
 */
export class MySqlPruneExpiredRecordsJob<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
	TSchema extends Record<string, unknown> = Record<string, never>,
> extends Job<Record<string, never>> {
	readonly name: string;
	private readonly batchSize: number;
	private readonly maxBatches: number;

	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>,
		private readonly targets: readonly MySqlPruneTarget[],
		options: MySqlPruneExpiredRecordsJobOptions = {},
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
	private async pruneTarget(target: MySqlPruneTarget): Promise<void> {
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
