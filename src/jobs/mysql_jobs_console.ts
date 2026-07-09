/**
 * A minimal console for operationally inspecting and adjusting the `jobs` table used by
 * `MySqlDatabaseJobQueue`/`MySqlDatabaseJobWorker` (`mysql_database_job_queue.ts`/
 * `mysql_database_job_worker.ts`). A parallel dialect implementation of
 * `sqlite_jobs_console.ts`'s `SQLiteJobsConsole`, sharing the same contract (API,
 * algorithm, JSDoc structure) ported to mysql-core (see `mysql_model.ts`'s JSDoc).
 * **Does not provide an HTML screen. Wiring it to HTTP (exposing it as an admin API) is
 * also the application's responsibility** (see `sqlite_jobs_console.ts`'s module
 * JSDoc).
 *
 * **How rowsAffected is obtained (a MySQL-specific compromise)**: since MySQL doesn't
 * support `UPDATE`/`DELETE ... RETURNING` (see the "how rowsAffected is obtained" note
 * in `mysql_database_job_worker.ts`'s module JSDoc), rowsAffected can't be determined
 * from the row count of `.returning({ id })` as in the SQLite/Pg versions. This class
 * uses the same technique as `MySqlDatabaseJobWorker#rowsAffectedFrom` (reading
 * `affectedRows` off mysql2's `[ResultSetHeader, FieldPacket[]]` result shape) via a
 * `protected rowsAffectedFrom` hook. The default implementation only supports the
 * mysql2 shape; subclasses using a non-mysql2 driver (e.g. PlanetScale) should override
 * it.
 *
 * `db` (`MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>`) and `table`
 * (`MySqlJobRecordTable`) are both constructor-injected, same as
 * `MySqlDatabaseJobQueue`/`MySqlDatabaseJobWorker`.
 */
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type {
	MySqlDatabase,
	MySqlQueryResultHKT,
	PreparedQueryHKTBase,
} from "drizzle-orm/mysql-core";
import type { MySqlJobRecordTable } from "./mysql_database_job_queue.js";

/**
 * Shape of a mysql2 driver `update`/`delete` result (`[ResultSetHeader, FieldPacket[]]`).
 * Identical to `mysql_database_job_worker.ts`'s `MySql2StyleResult` (duplicated here
 * since it's a private helper — same reasoning as the `sleep` duplication in
 * `sqlite_database_job_worker.ts`).
 */
type MySql2StyleResult = readonly [{ affectedRows: number }, ...unknown[]];

/** Whether `value` has the mysql2 result shape readable by the default `rowsAffectedFrom` implementation. */
const isMySql2StyleResult = (value: unknown): value is MySql2StyleResult =>
	Array.isArray(value) &&
	value.length > 0 &&
	typeof value[0] === "object" &&
	value[0] !== null &&
	"affectedRows" in value[0] &&
	typeof value[0].affectedRows === "number";

/**
 * Upper bound applied to `limit` in `listPending`/`listFailed` (same value and reasoning
 * as `SQLiteJobsConsole`). Prevents the operations console from loading every row even
 * if the caller passes a huge value.
 */
const MAX_LIST_LIMIT = 1000;

export class MySqlJobsConsole<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>,
		private readonly table: MySqlJobRecordTable,
	) {}

	/**
	 * Reads the number of rows actually changed from an `update()`/`delete()` result
	 * (see the "how rowsAffected is obtained" note in the module JSDoc). The default
	 * implementation reads the mysql2 result shape. Subclasses using a non-mysql2
	 * driver (e.g. PlanetScale) should override this method (same design as
	 * `MySqlDatabaseJobWorker#rowsAffectedFrom`).
	 */
	protected rowsAffectedFrom(result: unknown): number {
		if (isMySql2StyleResult(result)) return result[0].affectedRows;
		throw new Error(
			"MySqlJobsConsole#rowsAffectedFrom: unknown execution result shape. " +
				"When using a non-mysql2 driver (e.g. PlanetScale), override rowsAffectedFrom " +
				"in a subclass to read the affected row count from that driver's result shape.",
		);
	}

	/**
	 * Returns up to `limit` (default 100, clamped to `MAX_LIST_LIMIT`) not-yet-failed
	 * rows (`failedAt IS NULL`), ordered by `priority` ascending with `runAt` ascending
	 * as the tiebreaker. Same ordering as the claim order in
	 * `MySqlDatabaseJobWorker#runOnce`.
	 */
	async listPending(limit = 100) {
		return this.db
			.select()
			.from(this.table)
			.where(isNull(this.table.failedAt))
			.orderBy(asc(this.table.priority), asc(this.table.runAt))
			.limit(Math.min(limit, MAX_LIST_LIMIT));
	}

	/**
	 * Returns up to `limit` (default 100, clamped to `MAX_LIST_LIMIT`) failed rows
	 * (`failedAt IS NOT NULL`), ordered by `failedAt` descending (most recent failure
	 * first).
	 */
	async listFailed(limit = 100) {
		return this.db
			.select()
			.from(this.table)
			.where(isNotNull(this.table.failedAt))
			.orderBy(desc(this.table.failedAt))
			.limit(Math.min(limit, MAX_LIST_LIMIT));
	}

	/**
	 * Resets a failed row (`id` match and `failedAt IS NOT NULL`) to a retryable state.
	 * Sets `failedAt`/`lastError` to null, `attempts` to 0, and `runAt` to now. Also
	 * resetting `lockedAt` to null matters here: a row whose `failedAt` was set after
	 * hitting `maxAttempts` is left with `lockedAt` uncleared by
	 * `MySqlDatabaseJobWorker#markFailure`, so without resetting it here the row would
	 * never satisfy `MySqlDatabaseJobWorker#runOnce`'s claim condition and would never
	 * run again. Returns `true` if a row was updated (i.e. a failed row existed),
	 * `false` if no matching or not-yet-failed row exists (via `rowsAffectedFrom`; see
	 * the "how rowsAffected is obtained" note in the module JSDoc).
	 */
	async retryFailed(id: string): Promise<boolean> {
		const result = await this.db
			.update(this.table)
			.set({
				failedAt: null,
				lastError: null,
				attempts: 0,
				lockedAt: null,
				runAt: Date.now(),
			})
			.where(and(eq(this.table.id, id), isNotNull(this.table.failedAt)));
		return this.rowsAffectedFrom(result) === 1;
	}

	/**
	 * Deletes the row matching `id`, regardless of its state (pending/failed). Returns
	 * `true` if deleted, `false` if no matching row exists.
	 */
	async deleteJob(id: string): Promise<boolean> {
		const result = await this.db.delete(this.table).where(eq(this.table.id, id));
		return this.rowsAffectedFrom(result) === 1;
	}
}
