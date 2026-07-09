/**
 * Development-time `JobQueue` implementation. Skips any real queue transport and
 * immediately runs the target job's `perform` via `JobRegistry` when `enqueue` is called
 * (for local development and test environments without a Cloudflare Queues binding).
 *
 * `enqueue` intentionally goes through `registry` instead of calling the passed `job`
 * instance directly, so that the same "look up by job name" path used in production
 * (`CloudflareJobQueue` + `queue_consumer.ts`) also surfaces missing registrations
 * (forgetting to call `JobRegistry#register`) during development.
 *
 * `options.delaySeconds` is only validated, never actually waited on: simulating the
 * timer delay in a development adapter would only slow down tests without helping the
 * missing-registration detection above, which is this adapter's real purpose.
 * `options.priority` is likewise only validated and then ignored, since this adapter
 * always runs immediately (only the DB-backed queue adapters interpret priority).
 */
import type { Job } from "./job.js";
import type { EnqueueOptions } from "./job_queue.js";
import { assertValidEnqueueOptions, JobQueue } from "./job_queue.js";
import type { JobRegistry } from "./job_registry.js";

export class InlineJobQueue extends JobQueue {
	constructor(private readonly registry: JobRegistry) {
		super();
	}

	async enqueue<TPayload>(
		job: Job<TPayload>,
		payload: TPayload,
		options?: EnqueueOptions,
	): Promise<void> {
		assertValidEnqueueOptions(options);

		const registered = this.registry.resolve(job.name);
		if (!registered) {
			throw new Error(`Job "${job.name}" is not registered in JobRegistry`);
		}

		await registered.perform(payload);
	}
}
