/**
 * Verifies `CloudflareEmailMailer` (the `MailMessage` -> `EmailMessageBuilder`
 * mapping and the header-injection guard). The `SendEmail` binding is mimicked
 * with a minimal structural stub, so this runs under the node test project
 * without workerd.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { CloudflareEmailMailer } from "../../src/cloudflare/cloudflare_email_mailer.js";
import type { MailMessage } from "../../src/mailer/mailer.js";

/**
 * A single function type wide enough to satisfy both of `SendEmail.send`'s
 * overloads, so `vi.fn` can be assigned directly to `SendEmail`. This adapter
 * only ever calls the `EmailMessageBuilder` overload; callers narrow the
 * captured argument accordingly.
 */
type SendBuilder = (message: EmailMessage | EmailMessageBuilder) => Promise<EmailSendResult>;

/** A minimal stub satisfying `SendEmail`, returning the `send` mock itself (see queue.test.ts for why). */
const buildSendEmailStub = () => {
	const send = vi.fn<SendBuilder>(async () => ({ messageId: "test-id" }));
	const binding: SendEmail = { send };
	return { binding, send };
};

const buildMessage = (): MailMessage => ({
	from: "no-reply@example.com",
	to: "listener@example.com",
	subject: "Test subject",
	textBody: "Body",
});

describe("CloudflareEmailMailer", () => {
	test("maps from/to/subject/textBody onto the builder and calls binding.send once", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send(buildMessage());

		expect(send).toHaveBeenCalledTimes(1);
		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.from).toBe("no-reply@example.com");
		expect(builder.to).toEqual(["listener@example.com"]);
		expect(builder.subject).toBe("Test subject");
		expect(builder.text).toBe("Body");
	});

	test("htmlBody is mapped to builder.html when present", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({ ...buildMessage(), htmlBody: "<p>Body</p>" });

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.html).toBe("<p>Body</p>");
	});

	test("builder.html is undefined when htmlBody is omitted", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send(buildMessage());

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.html).toBeUndefined();
	});

	test("a single string to/cc/bcc is normalized into a one-element array", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({
			...buildMessage(),
			cc: "cc@example.com",
			bcc: "bcc@example.com",
		});

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.to).toEqual(["listener@example.com"]);
		expect(builder.cc).toEqual(["cc@example.com"]);
		expect(builder.bcc).toEqual(["bcc@example.com"]);
	});

	test("an array to/cc/bcc is passed through as-is", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({
			...buildMessage(),
			to: ["listener1@example.com", "listener2@example.com"],
			cc: ["cc1@example.com", "cc2@example.com"],
			bcc: ["bcc1@example.com", "bcc2@example.com"],
		});

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.to).toEqual(["listener1@example.com", "listener2@example.com"]);
		expect(builder.cc).toEqual(["cc1@example.com", "cc2@example.com"]);
		expect(builder.bcc).toEqual(["bcc1@example.com", "bcc2@example.com"]);
	});

	test("cc/bcc are omitted from the builder when not specified", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send(buildMessage());

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.cc).toBeUndefined();
		expect(builder.bcc).toBeUndefined();
	});

	test("an attachment with default (utf8) encoding is base64-encoded, with type and disposition set", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({
			...buildMessage(),
			attachments: [{ filename: "note.txt", content: "hello", contentType: "text/plain" }],
		});

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.attachments).toEqual([
			{
				disposition: "attachment",
				filename: "note.txt",
				type: "text/plain",
				// "hello" base64-encoded
				content: "aGVsbG8=",
			},
		]);
	});

	test("an attachment with encoding: base64 is passed through without re-encoding", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({
			...buildMessage(),
			attachments: [
				{
					filename: "note.txt",
					content: "aGVsbG8=",
					encoding: "base64",
					contentType: "text/plain",
				},
			],
		});

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		expect(builder.attachments?.[0]?.content).toBe("aGVsbG8=");
	});

	test("non-ASCII utf8 attachment content round-trips through base64 without throwing", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await mailer.send({
			...buildMessage(),
			attachments: [{ filename: "note.txt", content: "こんにちは", contentType: "text/plain" }],
		});

		const builder = send.mock.calls[0]?.[0] as EmailMessageBuilder;
		const encoded = builder.attachments?.[0]?.content as string;
		const decoded = new TextDecoder().decode(
			Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)),
		);
		expect(decoded).toBe("こんにちは");
	});

	test("a CRLF in from throws without calling binding.send", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await expect(
			mailer.send({ ...buildMessage(), from: "attacker@example.com\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/from.*line break/);
		expect(send).not.toHaveBeenCalled();
	});

	test("a CRLF in to throws without calling binding.send", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await expect(
			mailer.send({ ...buildMessage(), to: "listener@example.com\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/to.*line break/);
		expect(send).not.toHaveBeenCalled();
	});

	test("a CRLF in subject throws without calling binding.send", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await expect(
			mailer.send({ ...buildMessage(), subject: "Test subject\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/subject.*line break/);
		expect(send).not.toHaveBeenCalled();
	});

	test("an empty to array after normalization throws without calling binding.send", async () => {
		const { binding, send } = buildSendEmailStub();
		const mailer = new CloudflareEmailMailer(binding);

		await expect(mailer.send({ ...buildMessage(), to: [] })).rejects.toThrow(
			/at least one recipient \(to\)/,
		);
		expect(send).not.toHaveBeenCalled();
	});

	test("a binding.send rejection propagates from mailer.send", async () => {
		const send = vi.fn<SendBuilder>(async () => {
			throw new Error("quota exceeded");
		});
		const binding: SendEmail = { send };
		const mailer = new CloudflareEmailMailer(binding);

		await expect(mailer.send(buildMessage())).rejects.toThrow(/quota exceeded/);
	});
});
