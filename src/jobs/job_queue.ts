/**
 * Abstract base for the enqueue side of a job. Making `enqueue` generic lets the
 * compiler enforce, at the call site, that the `Job` instance passed in matches the
 * payload's type (the boundary cast on the `job_registry.ts` side relies on this
 * guarantee).
 *
 * Adapters: `CloudflareJobQueue` (production; actually forwards to Cloudflare Queues)
 * and `InlineJobQueue` (development; skips transport and runs immediately).
 */
import type { Job } from "./job.js";

/**
 * Options for `JobQueue#enqueue`. Interpretation differs per adapter (e.g.
 * `CloudflareJobQueue` actually forwards the delay to Cloudflare Queues, while
 * `InlineJobQueue` only validates it and ignores the delay itself, since it's for
 * development).
 */
export type EnqueueOptions = {
	/**
	 * Number of seconds to delay execution. Only non-negative integers are allowed.
	 * The upper bound follows each queue backend's own constraint (e.g. Cloudflare
	 * Queues caps at 43200 seconds = 12 hours).
	 */
	delaySeconds?: number;

	/**
	 * Priority. Only integers are allowed (negative values too). Lower values mean
	 * higher priority (a common priority-queue convention). Defaults to 0. Only the
	 * DB-backed queue adapters (e.g.
	 * `SQLiteDatabaseJobQueue`) interpret this and reflect it in claim order.
	 * Cloudflare Queues has no notion of priority, so `CloudflareJobQueue` only
	 * validates it and ignores the value.
	 */
	priority?: number;
};

/**
 * Runtime validation for `EnqueueOptions`. Throws if `delaySeconds` is not a
 * non-negative integer, or if `priority` is not an integer.
 * Each adapter calls this at the start of `enqueue` so invalid values are never
 * silently ignored or rounded.
 */
export const assertValidEnqueueOptions = (options: EnqueueOptions | undefined): void => {
	if (options?.delaySeconds !== undefined) {
		if (!Number.isInteger(options.delaySeconds) || options.delaySeconds < 0) {
			throw new Error(
				`delaySeconds must be a non-negative integer (received: ${options.delaySeconds})`,
			);
		}
	}

	if (options?.priority !== undefined) {
		if (!Number.isInteger(options.priority)) {
			throw new Error(`priority must be an integer (received: ${options.priority})`);
		}
	}
};

export abstract class JobQueue {
	/** Enqueues `job` with `payload`. `options.delaySeconds` schedules delayed execution. */
	abstract enqueue<TPayload>(
		job: Job<TPayload>,
		payload: TPayload,
		options?: EnqueueOptions,
	): Promise<void>;
}
