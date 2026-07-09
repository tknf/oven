/**
 * MySQL (mysql-core) version of the consumer that polls and executes rows enqueued by
 * `MySqlDatabaseJobQueue` (`mysql_database_job_queue.ts`). A parallel dialect
 * implementation of `sqlite_database_job_worker.ts`'s `SQLiteDatabaseJobWorker`, sharing
 * the same contract (claim strategy, at-least-once delivery, handling of unknown job
 * names, retry planning) ported to mysql-core (same decision as `sqlite_model.ts`'s
 * parallel dialect implementations).
 *
 * **Claim strategy, delivery guarantee, handling of unknown job names**: identical to
 * `sqlite_database_job_worker.ts`'s module JSDoc (the same algorithm is reused across
 * all three dialects without relying on dialect-specific features such as
 * `SELECT ... FOR UPDATE SKIP LOCKED`).
 *
 * **How rowsAffected is obtained (a MySQL-specific compromise)**: since MySQL doesn't
 * support `UPDATE ... RETURNING` (see the "handling the lack of RETURNING support" note
 * in `mysql_model.ts`'s module JSDoc), claim success can't be determined from the row
 * count of `.returning({ id })` as in the SQLite/Pg versions. This class uses the same
 * technique as `MySqlModel#rowsAffectedFrom` (reading `affectedRows` off mysql2's
 * `[ResultSetHeader, FieldPacket[]]` result shape) via a `protected rowsAffectedFrom`
 * hook. The default implementation only supports the mysql2 shape; subclasses using a
 * non-mysql2 driver (e.g. PlanetScale) should override it.
 *
 * `db` (`MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>`; see `mysql_model.ts`'s
 * module JSDoc), `table` (`MySqlJobRecordTable`; see `mysql_database_job_queue.ts`), and
 * `registry` (`JobRegistry`) are all constructor-injected.
 *
 * `DatabaseJobWorkerOptions`/`DatabaseJobWorkerHooks` are dialect-independent types, so
 * they are imported and reused from `sqlite_database_job_worker.ts` (not redefined here).
 */
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type {
	MySqlDatabase,
	MySqlQueryResultHKT,
	PreparedQueryHKTBase,
} from "drizzle-orm/mysql-core";
import type { MySqlJobRecordTable } from "./mysql_database_job_queue.js";
import type {
	DatabaseJobWorkerHooks,
	DatabaseJobWorkerOptions,
} from "./sqlite_database_job_worker.js";
import type { JobRegistry } from "./job_registry.js";

export type { DatabaseJobWorkerHooks, DatabaseJobWorkerOptions };

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 300;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_SECONDS = (attempt: number): number =>
	Math.min(3600, 30 * 2 ** (attempt - 1));

/** The subset of columns from a `runOnce` candidate row needed for processing. */
type ClaimCandidate = {
	id: string;
	name: string;
	payload: string;
	attempts: number;
};

/**
 * Shape of a mysql2 driver `update` result (`[ResultSetHeader, FieldPacket[]]`).
 * Identical to `mysql_model.ts`'s `MySql2StyleResult` (duplicated here since it's a
 * private helper — same reasoning as the `sleep` duplication in
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
 * Returns a Promise that resolves after `ms` milliseconds, or as soon as `signal` is
 * aborted, whichever comes first. Identical implementation to the same-named helper in
 * `sqlite_database_job_worker.ts` (duplicating it across each dialect file follows the
 * project's "three similar lines beat premature abstraction" policy).
 */
const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}

		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});

export class MySqlDatabaseJobWorker<
	TQueryResult extends MySqlQueryResultHKT,
	TPreparedQueryHKT extends PreparedQueryHKTBase,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly maxAttempts: number;
	private readonly backoffSeconds: (attempt: number) => number;
	private readonly visibilityTimeoutSeconds: number;
	private readonly batchSize: number;
	private readonly hooks: DatabaseJobWorkerHooks;

	constructor(
		private readonly db: MySqlDatabase<TQueryResult, TPreparedQueryHKT, TSchema>,
		private readonly table: MySqlJobRecordTable,
		private readonly registry: JobRegistry,
		options: DatabaseJobWorkerOptions = {},
		hooks: DatabaseJobWorkerHooks = {},
	) {
		this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
		this.backoffSeconds = options.backoffSeconds ?? DEFAULT_BACKOFF_SECONDS;
		this.visibilityTimeoutSeconds =
			options.visibilityTimeoutSeconds ?? DEFAULT_VISIBILITY_TIMEOUT_SECONDS;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.hooks = hooks;
	}

	/**
	 * Reads the number of rows actually changed from an `update()` result (see the
	 * "how rowsAffected is obtained" note in the module JSDoc). The default
	 * implementation reads the mysql2 result shape. Subclasses using a non-mysql2
	 * driver (e.g. PlanetScale) should override this method (same design as
	 * `MySqlModel#rowsAffectedFrom`).
	 */
	protected rowsAffectedFrom(result: unknown): number {
		if (isMySql2StyleResult(result)) return result[0].affectedRows;
		throw new Error(
			"MySqlDatabaseJobWorker#rowsAffectedFrom: unknown execution result shape. " +
				"When using a non-mysql2 driver (e.g. PlanetScale), override rowsAffectedFrom " +
				"in a subclass to read the affected row count from that driver's result shape.",
		);
	}

	/**
	 * Claims up to `batchSize` runnable rows and processes them. Candidates are claimed
	 * in `priority` ascending order (lower is higher priority), with `runAt` ascending
	 * as the tiebreaker. Returns the number of rows successfully claimed and attempted
	 * (including unknown jobs and errors; skipped rows are not counted).
	 */
	async runOnce(): Promise<number> {
		const now = Date.now();
		const staleBefore = now - this.visibilityTimeoutSeconds * 1000;
		const unclaimed = or(isNull(this.table.lockedAt), lt(this.table.lockedAt, staleBefore));

		const candidates = await this.db
			.select({
				id: this.table.id,
				name: this.table.name,
				payload: this.table.payload,
				attempts: this.table.attempts,
			})
			.from(this.table)
			.where(and(isNull(this.table.failedAt), lte(this.table.runAt, now), unclaimed))
			.orderBy(asc(this.table.priority), asc(this.table.runAt))
			.limit(this.batchSize);

		let processed = 0;
		for (const candidate of candidates) {
			const claimedAt = Date.now();
			const result = await this.db
				.update(this.table)
				.set({ lockedAt: claimedAt })
				.where(and(eq(this.table.id, candidate.id), isNull(this.table.failedAt), unclaimed));
			/**
			 * If another worker already claimed this row, the affected count is 0 (via
			 * `rowsAffectedFrom`; see the "how rowsAffected is obtained" note in the
			 * module JSDoc). In that case, skip this row and move on to the next candidate.
			 */
			if (this.rowsAffectedFrom(result) !== 1) continue;

			processed += 1;
			await this.processClaimedRow(candidate);
		}

		return processed;
	}

	/**
	 * Polling loop for long-running processes such as Node. Same contract as `run` in
	 * `sqlite_database_job_worker.ts` (repeats `runOnce` until `signal.aborted`, waiting
	 * `intervalMs` only when a batch processed zero rows).
	 */
	async run({
		signal,
		intervalMs = DEFAULT_INTERVAL_MS,
	}: {
		signal: AbortSignal;
		intervalMs?: number;
	}): Promise<void> {
		while (!signal.aborted) {
			const processed = await this.runOnce();
			if (processed === 0) {
				await sleep(intervalMs, signal);
			}
		}
	}

	/**
	 * Processes a single claimed row. An unregistered job name is immediately marked as
	 * failed with no retry (see the module JSDoc). If registered, JSON-parses `payload`
	 * and calls `perform`; on success the row is deleted, on failure `markFailure`
	 * builds a retry plan.
	 */
	private async processClaimedRow(candidate: ClaimCandidate): Promise<void> {
		const registered = this.registry.resolve(candidate.name);
		if (!registered) {
			await this.db
				.update(this.table)
				.set({
					failedAt: Date.now(),
					lastError: `Aborted: unregistered job name "${candidate.name}"`,
				})
				.where(eq(this.table.id, candidate.id));
			this.hooks.onUnknownJob?.(candidate.name);
			return;
		}

		try {
			const payload: unknown = JSON.parse(candidate.payload);
			await registered.perform(payload);
			await this.db.delete(this.table).where(eq(this.table.id, candidate.id));
		} catch (error) {
			this.hooks.onJobError?.(candidate.name, error);
			await this.markFailure(candidate, error);
		}
	}

	/**
	 * Builds a retry plan for a failed row. Same algorithm as `markFailure` in
	 * `sqlite_database_job_worker.ts` (increments `attempts` by 1; if the limit is
	 * reached, sets `failedAt`/`lastError`; otherwise advances `runAt` to
	 * `backoffSeconds(attempts)` seconds later and resets `lockedAt` to `null`).
	 */
	private async markFailure(candidate: ClaimCandidate, error: unknown): Promise<void> {
		const attempts = candidate.attempts + 1;
		const now = Date.now();

		if (attempts >= this.maxAttempts) {
			await this.db
				.update(this.table)
				.set({ attempts, failedAt: now, lastError: String(error) })
				.where(eq(this.table.id, candidate.id));
			return;
		}

		await this.db
			.update(this.table)
			.set({ attempts, runAt: now + this.backoffSeconds(attempts) * 1000, lockedAt: null })
			.where(eq(this.table.id, candidate.id));
	}
}
