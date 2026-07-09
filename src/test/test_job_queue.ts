/**
 * Test implementation of `JobQueue`. Performs no real enqueueing; it simply
 * accumulates each call into `enqueued`. Used as assertion support so tests
 * can verify which job was enqueued with which payload/options. Exported only
 * from `src/test/index.ts`, not from the core `src/index.ts` (since it's
 * test-only).
 */
import type { Job } from "../jobs/job.js";
import type { EnqueueOptions } from "../jobs/job_queue.js";
import { assertValidEnqueueOptions, JobQueue } from "../jobs/job_queue.js";

/** A single enqueue call recorded by `TestJobQueue`. */
export type EnqueuedJob = {
	name: string;
	payload: unknown;
	options?: EnqueueOptions;
};

export class TestJobQueue extends JobQueue {
	/** Recorded enqueue calls, in call order. */
	readonly enqueued: EnqueuedJob[] = [];

	async enqueue<TPayload>(
		job: Job<TPayload>,
		payload: TPayload,
		options?: EnqueueOptions,
	): Promise<void> {
		assertValidEnqueueOptions(options);

		this.enqueued.push({ name: job.name, payload, options });
	}

	/**
	 * Returns only the typed payloads that were enqueued for `job` (records for
	 * other job names are excluded). Thanks to `enqueue`'s generic contract, any
	 * recorded entry whose `job.name` matches is guaranteed to have a `payload`
	 * of type `TPayload` (the same assumption used for the boundary cast in
	 * `job_registry.ts`).
	 */
	enqueuedOf<TPayload>(job: Job<TPayload>): TPayload[] {
		return this.enqueued
			.filter((entry) => entry.name === job.name)
			.map((entry) => entry.payload as TPayload);
	}

	/** Clears the accumulated enqueue records (for cleanup between tests). */
	clear(): void {
		this.enqueued.length = 0;
	}
}
