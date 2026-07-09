/**
 * Postgres (pg-core) version of the consumer that polls and executes rows enqueued by
 * `PgDatabaseJobQueue` (`pg_database_job_queue.ts`). A parallel dialect implementation
 * of `sqlite_database_job_worker.ts`'s `SQLiteDatabaseJobWorker`, sharing the same
 * contract (claim strategy, at-least-once delivery, handling of unknown job names,
 * retry planning) ported to pg-core (same decision as `sqlite_model.ts`'s parallel
 * dialect implementations).
 *
 * **Claim strategy, delivery guarantee, handling of unknown job names**: identical to
 * `sqlite_database_job_worker.ts`'s module JSDoc (the same algorithm is reused across
 * all three dialects without relying on dialect-specific features such as
 * `SELECT ... FOR UPDATE SKIP LOCKED`). rowsAffected is likewise counted from the
 * length of the `.returning({ id })` row array (Postgres supports
 * `UPDATE ... RETURNING`, for the same reason as `PgModel#updateWhere`).
 *
 * `db` (`PgDatabase<TQueryResult, TSchema>`; see `pg_model.ts`'s module JSDoc for why
 * `TQueryResult` is promoted to a class type parameter), `table` (`PgJobRecordTable`;
 * see `pg_database_job_queue.ts`), and `registry` (`JobRegistry`) are all
 * constructor-injected.
 *
 * `DatabaseJobWorkerOptions`/`DatabaseJobWorkerHooks` are dialect-independent types, so
 * they are imported and reused from `sqlite_database_job_worker.ts` (not redefined here).
 */
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { PgJobRecordTable } from "./pg_database_job_queue.js";
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

export class PgDatabaseJobWorker<
	TQueryResult extends PgQueryResultHKT,
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly maxAttempts: number;
	private readonly backoffSeconds: (attempt: number) => number;
	private readonly visibilityTimeoutSeconds: number;
	private readonly batchSize: number;
	private readonly hooks: DatabaseJobWorkerHooks;

	constructor(
		private readonly db: PgDatabase<TQueryResult, TSchema>,
		private readonly table: PgJobRecordTable,
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
			const claimed = await this.db
				.update(this.table)
				.set({ lockedAt: claimedAt })
				.where(and(eq(this.table.id, candidate.id), isNull(this.table.failedAt), unclaimed))
				.returning({ id: this.table.id });
			/**
			 * If another worker already claimed this row, the result is 0 rows (same
			 * technique as `PgModel#updateWhere` — counting rowsAffected from the
			 * `.returning()` row count). In that case, skip this row and move on to the
			 * next candidate.
			 */
			if (claimed.length !== 1) continue;

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
