/**
 * Ready-made `Job` implementation that puts a `Mailer` on the job queue
 * for enqueued (asynchronous) delivery. Register it with
 * `registry.register(new DeliverMailJob(mailer))`, then enqueue a send with
 * `queue.enqueue(deliverMailJob, message)` wherever you need to send mail.
 * Combine it with `EnqueueOptions.delaySeconds` for delayed delivery (see
 * `JobQueue#enqueue`).
 *
 * `MailMessage` can be used directly as the payload because it follows a
 * JSON-serializable contract (attachment `content` is a base64 string; see
 * `src/mailer/mailer.ts`).
 *
 * When using multiple `Mailer`s, give each one a unique job name via
 * `options.name` and register a separate instance per `Mailer`
 * (`JobRegistry#register` throws on duplicate names, so you cannot register
 * more than one job under the default name).
 *
 * Send failures (a throw from `Mailer#send`) propagate as-is. `InlineJobQueue`
 * throws immediately, while the `CloudflareJobQueue` + `QueueConsumer` path
 * relies on the consumer's retry behavior.
 */
import { Job } from "../jobs/job.js";
import type { Mailer, MailMessage } from "./mailer.js";

/** Constructor options for `DeliverMailJob`. */
export type DeliverMailJobOptions = {
	/** Job name. Defaults to `"oven:deliver_mail"`. Override when using multiple `Mailer`s. */
	name?: string;
};

/** `Job` that delivers a `MailMessage` through the given `Mailer` when it runs. */
export class DeliverMailJob extends Job<MailMessage> {
	readonly name: string;

	constructor(
		private readonly mailer: Mailer,
		options?: DeliverMailJobOptions,
	) {
		super();
		this.name = options?.name ?? "oven:deliver_mail";
	}

	async perform(message: MailMessage): Promise<void> {
		await this.mailer.send(message);
	}
}
