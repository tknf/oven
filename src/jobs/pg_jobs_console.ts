/**
 * A minimal console for operationally inspecting and adjusting the `jobs` table used by
 * `PgDatabaseJobQueue`/`PgDatabaseJobWorker` (`pg_database_job_queue.ts`/
 * `pg_database_job_worker.ts`). A parallel dialect implementation of
 * `sqlite_jobs_console.ts`'s `SQLiteJobsConsole`, sharing the same contract (API,
 * algorithm, JSDoc structure) ported to pg-core (see `pg_model.ts`'s JSDoc).
 * **Does not provide an HTML screen. Wiring it to HTTP (exposing it as an admin API) is
 * also the application's responsibility** (see `sqlite_jobs_console.ts`'s module
 * JSDoc).
 *
 * `db` (`PgDatabase<TQueryResult, TSchema>`) and `table` (`PgJobRecordTable`) are both
 * constructor-injected, same as `PgDatabaseJobQueue`/`PgDatabaseJobWorker`.
 */
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgJobRecordTable } from "./pg_database_job_queue.js";

/**
 * Upper bound applied to `limit` in `listPending`/`listFailed` (same value and reasoning
 * as `SQLiteJobsConsole`). Prevents the operations console from loading every row even
 * if the caller passes a huge value.
 */
const MAX_LIST_LIMIT = 1000;

export class PgJobsConsole<
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	constructor(
		private readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly table: PgJobRecordTable,
	) {}

	/**
	 * Returns up to `limit` (default 100, clamped to `MAX_LIST_LIMIT`) not-yet-failed
	 * rows (`failedAt IS NULL`), ordered by `priority` ascending with `runAt` ascending
	 * as the tiebreaker. Same ordering as the claim order in
	 * `PgDatabaseJobWorker#runOnce`.
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
	 * `PgDatabaseJobWorker#markFailure`, so without resetting it here the row would
	 * never satisfy `PgDatabaseJobWorker#runOnce`'s claim condition and would never
	 * run again. Returns `true` if a row was updated (i.e. a failed row existed),
	 * `false` if no matching or not-yet-failed row exists (same technique as
	 * `PgDatabaseJobWorker` — counting rowsAffected from the `.returning()` row count).
	 */
	async retryFailed(id: string): Promise<boolean> {
		const updated = await this.db
			.update(this.table)
			.set({
				failedAt: null,
				lastError: null,
				attempts: 0,
				lockedAt: null,
				runAt: Date.now(),
			})
			.where(and(eq(this.table.id, id), isNotNull(this.table.failedAt)))
			.returning({ id: this.table.id });
		return updated.length === 1;
	}

	/**
	 * Deletes the row matching `id`, regardless of its state (pending/failed). Returns
	 * `true` if deleted, `false` if no matching row exists.
	 */
	async deleteJob(id: string): Promise<boolean> {
		const deleted = await this.db
			.delete(this.table)
			.where(eq(this.table.id, id))
			.returning({ id: this.table.id });
		return deleted.length === 1;
	}
}
