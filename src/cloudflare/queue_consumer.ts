/**
 * Provides a `handle` method for a `JobRegistry` that can be called from a Workers queue
 * handler (`queue(batch, env, ctx)`).
 *
 * Assumes each message body is shaped as the `JobMessage` (`{ name, payload }`) that
 * `CloudflareJobQueue` sends. Messages in the batch are processed one at a time:
 *
 * - if the matching job's `perform` succeeds, `message.ack()`
 * - if `perform` throws, `message.retry()` (treated as a transient failure and retried)
 * - if no job is registered for `name`, **discard it with `message.ack()` without
 *   retrying**. An unknown job name means either the message body is corrupted or it is a
 *   stale message that stayed in the queue after the job itself was removed in a
 *   deployment — neither case is resolved by retrying. Retrying unconditionally would leave
 *   the same message stuck in the backlog as a poison message, so processing stops here
 *   (calling `hooks.onUnknownJob` so it can be detected).
 * - a body that isn't shaped like `{ name: string, ... }` at all (e.g. `null`/`undefined`,
 *   or a `name` that isn't a string) is treated the same way: acked and isolated with
 *   `hooks.onUnknownJob` called with `""`, instead of throwing and aborting the rest of
 *   the batch.
 *
 * Uses the Cloudflare Queues Message/MessageBatch API (`ack`/`retry`/`messages`).
 */
import type { JobMessage } from "./cloudflare_job_queue.js";
import type { JobRegistry } from "../jobs/job_registry.js";

/** Extracts a valid job name from an untrusted queue message body, or null if the body is malformed. */
const extractJobName = (body: unknown): string | null => {
	if (
		typeof body === "object" &&
		body !== null &&
		"name" in body &&
		typeof body.name === "string"
	) {
		return body.name;
	}
	return null;
};

/** Optional hooks for bridging events during message processing to logging, etc. */
export type QueueConsumerHooks = {
	/** Called when no job is registered for `name` (the message has already been acked). */
	onUnknownJob?: (name: string) => void;
	/** Called when a job's `perform` throws, right before `message.retry()`. */
	onJobError?: (name: string, error: unknown) => void;
};

/**
 * Provides a `handle` method for `registry` that can be called from a Workers queue
 * handler. Intended to be invoked as `await consumer.handle(batch)` from the app's
 * `queue(batch, env, ctx)` implementation.
 */
export class QueueConsumer {
	constructor(
		private readonly registry: JobRegistry,
		private readonly hooks: QueueConsumerHooks = {},
	) {}

	/**
	 * Processes a batch of queue messages, acking or retrying each based on job resolution
	 * and `perform` outcome. An arrow-function class field since it may be passed by
	 * reference to a Workers queue handler.
	 */
	readonly handle = async (batch: MessageBatch<JobMessage>): Promise<void> => {
		for (const message of batch.messages) {
			const name = extractJobName(message.body);
			const registered = name === null ? undefined : this.registry.resolve(name);

			if (!registered) {
				this.hooks.onUnknownJob?.(name ?? "");
				message.ack();
				continue;
			}

			try {
				await registered.perform(message.body.payload);
				message.ack();
			} catch (error) {
				this.hooks.onJobError?.(message.body.name, error);
				message.retry();
			}
		}
	};
}
