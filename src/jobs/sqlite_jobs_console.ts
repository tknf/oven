/**
 * A minimal console for operationally inspecting and adjusting the `jobs` table used by
 * `SQLiteDatabaseJobQueue`/`SQLiteDatabaseJobWorker` (`sqlite_database_job_queue.ts`/
 * `sqlite_database_job_worker.ts`). **Does not provide an HTML screen** (any admin UI is
 * the responsibility of the app calling this class). **Wiring it to HTTP (exposing it
 * as an admin API) is also the application's responsibility** (in keeping with the
 * "make maximum use of Hono's own features as a thin wrapper" policy — oven itself has
 * no routing).
 *
 * `db` (`BaseSQLiteDatabase`) and `table` (`SQLiteJobRecordTable`) are both
 * constructor-injected, same as `SQLiteDatabaseJobQueue`/`SQLiteDatabaseJobWorker`. The
 * column contract type (`SQLiteJobRecordTable`) is reused as-is; no separate type is
 * defined here.
 *
 * **Parallel dialect implementations**: the Postgres version is implemented
 * independently as `PgJobsConsole` in `pg_jobs_console.ts`, and the MySQL version as
 * `MySqlJobsConsole` in `mysql_jobs_console.ts` (same decision as `sqlite_model.ts` —
 * no common abstraction is built, since Drizzle's type system is parallel rather than
 * shared across dialects).
 */
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SQLiteJobRecordTable } from "./sqlite_database_job_queue.js";

/**
 * Upper bound applied to `limit` in `listPending`/`listFailed`. A safety valve so the
 * operations console never loads every row even if the caller passes a huge value
 * (`limit` itself is clamped to this value via `Math.min`; it does not throw when
 * exceeded — the console's listing is meant for "viewing," so it doesn't need to be as
 * strict as `Model`'s IN-clause guard, `assertWithinMaxInValues`).
 */
const MAX_LIST_LIMIT = 1000;

export class SQLiteJobsConsole<TSchema extends Record<string, unknown> = Record<string, never>> {
	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: SQLiteJobRecordTable,
	) {}

	/**
	 * Returns up to `limit` (default 100, clamped to `MAX_LIST_LIMIT`) not-yet-failed
	 * rows (`failedAt IS NULL`), ordered by `priority` ascending with `runAt` ascending
	 * as the tiebreaker — the same ordering as the claim order in
	 * `SQLiteDatabaseJobWorker#runOnce`, so this directly shows "rows expected to be
	 * processed next."
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
	 * `SQLiteDatabaseJobWorker#markFailure`, so without resetting it here the row would
	 * never satisfy `SQLiteDatabaseJobWorker#runOnce`'s claim condition and would never
	 * run again. Returns `true` if a row was updated (i.e. a failed row existed),
	 * `false` if no matching or not-yet-failed row exists (same technique as
	 * `SQLiteDatabaseJobWorker` — counting rowsAffected from the `.returning()` row
	 * count).
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
