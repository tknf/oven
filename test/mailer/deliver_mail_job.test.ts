/**
 * Verifies `DeliverMailJob` (the standard job that puts `Mailer` on the job
 * queue). Registers it with `JobRegistry` and enqueues it through
 * `InlineJobQueue` to confirm that, following the real operational path
 * (registry resolution -> perform execution), the message actually reaches
 * `TestMailer`.
 */
import { describe, expect, test } from "vite-plus/test";
import { DeliverMailJob } from "../../src/mailer/deliver_mail_job.js";
import type { MailMessage } from "../../src/mailer/mailer.js";
import { Mailer } from "../../src/mailer/mailer.js";
import { InlineJobQueue } from "../../src/jobs/inline_job_queue.js";
import { JobRegistry } from "../../src/jobs/job_registry.js";
import { TestMailer } from "../../src/test/test_mailer.js";

/** Test-only `MailMessage` factory. */
const buildMessage = (overrides?: Partial<MailMessage>): MailMessage => ({
	from: "no-reply@example.com",
	to: "listener@example.com",
	subject: "Test subject",
	textBody: "Body",
	...overrides,
});

describe("DeliverMailJob", () => {
	test("the default job name is oven:deliver_mail", () => {
		const job = new DeliverMailJob(new TestMailer());

		expect(job.name).toBe("oven:deliver_mail");
	});

	test("the job name can be overridden via options.name", () => {
		const job = new DeliverMailJob(new TestMailer(), { name: "custom:deliver_mail" });

		expect(job.name).toBe("custom:deliver_mail");
	});

	test("registering with JobRegistry and enqueueing via InlineJobQueue sends through Mailer", async () => {
		const mailer = new TestMailer();
		const job = new DeliverMailJob(mailer);
		const registry = new JobRegistry();
		registry.register(job);
		const queue = new InlineJobQueue(registry);

		const message = buildMessage();
		await queue.enqueue(job, message);

		expect(mailer.sent).toEqual([message]);
	});

	test("a Mailer send failure propagates to enqueue", async () => {
		class FailingMailer extends Mailer {
			async send(): Promise<void> {
				throw new Error("send failed");
			}
		}

		const job = new DeliverMailJob(new FailingMailer());
		const registry = new JobRegistry();
		registry.register(job);
		const queue = new InlineJobQueue(registry);

		await expect(queue.enqueue(job, buildMessage())).rejects.toThrow(/send failed/);
	});
});
