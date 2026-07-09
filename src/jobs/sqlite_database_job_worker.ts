/**
 * The consumer side that polls and executes rows enqueued by `SQLiteDatabaseJobQueue`
 * (`sqlite_database_job_queue.ts`). Since the RDB alone handles the queue, no external
 * middleware such as Cloudflare Queues is required.
 *
 * **Claim strategy**: candidates are SELECTed, then each row is individually UPDATEd
 * (an optimistic claim) before being processed. This does not rely on dialect-specific
 * features such as `SELECT ... FOR UPDATE SKIP LOCKED` (a constraint that lets the same
 * algorithm be reused across SQLite/Postgres/MySQL — same decision as the parallel
 * dialect implementations in `sqlite_model.ts`). rowsAffected is counted the same way
 * as `SQLiteModel#updateWhere` — from the length of the `.returning({ id })` row array
 * (avoiding any dependency on a driver-specific execution result type).
 *
 * **Delivery guarantee is at-least-once**: if a worker crashes after `perform`
 * completes but before the DELETE, another worker will re-claim and re-run the same row
 * once `visibilityTimeoutSeconds` has elapsed. Job `perform` implementations must be
 * idempotent.
 *
 * **Unknown job names are never retried**: a row whose `registry.resolve` fails is
 * immediately marked with `failedAt` and removed from further processing (calling
 * `hooks.onUnknownJob`). This shares the same philosophy as `QueueConsumer` in
 * `cloudflare/queue_consumer.ts`, but where CF's QueueConsumer discards the message
 * itself via `message.ack()`, the DB queue instead leaves the row with `failedAt` set.
 * Since a DB queue's rows are themselves an observable record (they can later be
 * inspected with `SELECT * FROM jobs WHERE failed_at IS NOT NULL`), leaving a "failed"
 * row is more consistent here than discarding it.
 *
 * `db` (`BaseSQLiteDatabase`; assumes a libSQL/`@libsql/client`-family driver, but the
 * type itself is driver-independent), `table` (`SQLiteJobRecordTable`; see
 * `sqlite_database_job_queue.ts`), and `registry` (`JobRegistry`) are all
 * constructor-injected. `db`'s type is genericized over `TSchema` for the same reason
 * as `SQLiteDatabaseJobQueue` (so a `db` created with `drizzle(client, { schema })` can
 * be accepted as-is).
 *
 * **Parallel dialect implementations**: the Postgres version is implemented
 * independently as `pg_database_job_worker.ts`, and the MySQL version as
 * `mysql_database_job_worker.ts` (same decision as `sqlite_model.ts`).
 * `DatabaseJobWorkerOptions`/`DatabaseJobWorkerHooks` are dialect-independent in shape,
 * but for now are exported only from this file (whether to split them into a shared
 * file will be decided when porting to Pg/MySQL).
 */
import { and, asc, eq, isNull, lt, lte, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import type { SQLiteJobRecordTable } from "./sqlite_database_job_queue.js";
import type { JobRegistry } from "./job_registry.js";

export type DatabaseJobWorkerOptions = {
	/** Maximum retry count (including the initial attempt). Default 5. Once reached, `failedAt` is set and the row is no longer processed. */
	maxAttempts?: number;
	/**
	 * Function computing backoff seconds from the number of failed attempts
	 * (1-indexed). Defaults to exponential backoff `30 * 2 ** (attempt - 1)`, capped at
	 * 3600 seconds (1 hour).
	 */
	backoffSeconds?: (attempt: number) => number;
	/**
	 * Claim visibility timeout in seconds. A row whose `lockedAt` is older than this
	 * many seconds is considered abandoned (the worker that claimed it is assumed
	 * dead), allowing another worker to re-claim it. Default 300 seconds.
	 */
	visibilityTimeoutSeconds?: number;
	/** Maximum number of rows `runOnce` processes per call. Default 10. */
	batchSize?: number;
};

/** Optional hooks for bridging in-flight events to logging etc. (same vocabulary as `QueueConsumerHooks`). */
export type DatabaseJobWorkerHooks = {
	/** Called when no job is registered for `name` (the row has already been marked `failedAt`). */
	onUnknownJob?: (name: string) => void;
	/** Called when a job's `perform` throws (right before the retry decision). */
	onJobError?: (name: string, error: unknown) => void;
};

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
 * aborted, whichever comes first. Reliably clears the timer on abort and the event
 * listener on timeout, so `SQLiteDatabaseJobWorker#run`'s polling loop can stop without
 * leaking resources.
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

export class SQLiteDatabaseJobWorker<
	TSchema extends Record<string, unknown> = Record<string, never>,
> {
	private readonly maxAttempts: number;
	private readonly backoffSeconds: (attempt: number) => number;
	private readonly visibilityTimeoutSeconds: number;
	private readonly batchSize: number;
	private readonly hooks: DatabaseJobWorkerHooks;

	constructor(
		private readonly db: BaseSQLiteDatabase<"async", unknown, TSchema>,
		private readonly table: SQLiteJobRecordTable,
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
			 * technique as `SQLiteModel#updateWhere` — counting rowsAffected from the
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
	 * Polling loop for long-running processes such as Node. Repeats `runOnce` until
	 * `signal.aborted`. Waits `intervalMs` (default 1000) only when a batch processed
	 * zero rows; otherwise it proceeds straight to the next `runOnce` without waiting.
	 *
	 * Not for environments without a long-running loop, such as Cloudflare Workers —
	 * instead, call `runOnce()` directly from a cron via `ScheduledDispatcher`
	 * (`cloudflare/scheduled_dispatcher.ts`).
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
	 * Builds a retry plan for a failed row. Increments `attempts` by 1; if the limit
	 * (`maxAttempts`) is reached, sets `failedAt`/`lastError` so the row is never
	 * processed again. Otherwise, advances `runAt` to `backoffSeconds(attempts)` seconds
	 * later and resets `lockedAt` to `null` (so another worker can re-claim it without
	 * waiting for `visibilityTimeoutSeconds`).
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
