/**
 * A job-name-to-job lookup table. Both `InlineJobQueue` (development) and
 * `queue_consumer.ts` (the production Cloudflare Queues consumer) call `perform`
 * through this registry via the same "look up the job by name" path.
 */
import type { Job } from "./job.js";

/**
 * The executable entry kept inside the registry. Keeping `Job<TPayload>`'s `TPayload`
 * out of the registry's public surface and normalizing `perform`'s parameter to
 * `unknown` lets multiple jobs be mixed into a single `Map` in a type-safe way.
 */
export type RegisteredJob = {
	readonly name: string;
	perform(payload: unknown): Promise<void>;
};

export class JobRegistry {
	private readonly jobs = new Map<string, RegisteredJob>();

	/**
	 * Registers `job` keyed by `job.name`. Throws if a job with the same name is
	 * already registered (a name collision would otherwise silently overwrite the
	 * existing entry — a hard-to-notice bug — so this fails fast instead of
	 * failing safe).
	 */
	register<TPayload>(job: Job<TPayload>): void {
		if (this.jobs.has(job.name)) {
			throw new Error(`Job "${job.name}" is already registered`);
		}

		this.jobs.set(job.name, {
			name: job.name,
			/**
			 * At enqueue time (via `JobQueue#enqueue<TPayload>`'s type parameter), the
			 * Job instance and payload are guaranteed to match types. By the time the
			 * consumer side sees them, they have passed through queue transport and a
			 * JSON round-trip and are structurally `unknown`, so a boundary cast back
			 * to `TPayload` is needed here (as noted in `Job`'s JSDoc, keeping the
			 * payload JSON-serializable is the job implementation's responsibility).
			 */
			perform: (payload) => job.perform(payload as TPayload),
		});
	}

	/** Returns the registered job for `name`, or `undefined` if none is registered. */
	resolve(name: string): RegisteredJob | undefined {
		return this.jobs.get(name);
	}
}
