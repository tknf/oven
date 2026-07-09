/**
 * Verifies `FetchMailer` (the abstract base for fetch-based sending). Rather
 * than building a real vendor implementation, this uses a minimal test
 * subclass and a swappable `fetch`.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { FetchMailer } from "../../src/mailer/fetch_mailer.js";
import type { MailMessage } from "../../src/mailer/mailer.js";

/** Test implementation that puts the `MailMessage` received by `buildRequest` straight into the JSON body. */
class RecordingFetchMailer extends FetchMailer {
	protected buildRequest(message: MailMessage): Request {
		return new Request("https://mail.example.com/send", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(message),
		});
	}
}

const buildMessage = (): MailMessage => ({
	from: "no-reply@example.com",
	to: "listener@example.com",
	subject: "Test subject",
	textBody: "Body",
});

describe("FetchMailer", () => {
	test("calls fetch with the Request built by buildRequest and succeeds when ok", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await mailer.send(buildMessage());

		expect(fetchFn).toHaveBeenCalledTimes(1);
		const request = fetchFn.mock.calls[0]?.[0] as Request;
		expect(request.method).toBe("POST");
		expect(await request.json()).toEqual(buildMessage());
	});

	test("a non-2xx response throws an Error including the status code and body", async () => {
		const fetchFn = vi.fn<typeof fetch>(
			async () => new Response("bad request: invalid recipient", { status: 400 }),
		);
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(mailer.send(buildMessage())).rejects.toThrow(
			/400.*bad request: invalid recipient/,
		);
	});

	test("omitting fetch falls back to the global fetch", () => {
		const mailer = new RecordingFetchMailer();
		expect(mailer).toBeInstanceOf(FetchMailer);
	});

	test("when timeoutMs is set, a non-responding upstream is aborted via AbortSignal", async () => {
		const fetchFn = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) throw new Error("signal was not passed");
					signal.addEventListener("abort", () => reject(signal.reason));
				}),
		);
		const mailer = new RecordingFetchMailer(fetchFn, 5);

		await expect(mailer.send(buildMessage())).rejects.toThrow();
	});

	test("when timeoutMs is omitted, fetch is called without a signal as before", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await mailer.send(buildMessage());

		const init = fetchFn.mock.calls[0]?.[1];
		expect(init).toBeUndefined();
	});

	test("a CRLF in from throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), from: "attacker@example.com\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/from.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a CRLF in to throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), to: "listener@example.com\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/to.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a CRLF in subject throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), subject: "Test subject\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/subject.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a lone LF (\\n) is also rejected", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), subject: "Test subject\nBcc: victim@example.com" }),
		).rejects.toThrow(/subject.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a lone CR (\\r) is also rejected", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), subject: "Test subject\rBcc: victim@example.com" }),
		).rejects.toThrow(/subject.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a newline in textBody sends fine since the body is not checked", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await mailer.send({ ...buildMessage(), textBody: "Line 1\r\nLine 2\nLine 3" });

		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	test("when to is an array, every address is checked and any newline throws", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({
				...buildMessage(),
				to: ["listener1@example.com", "listener2@example.com\r\nBcc: victim@example.com"],
			}),
		).rejects.toThrow(/to.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a CRLF in cc throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), cc: "cc@example.com\r\nBcc: victim@example.com" }),
		).rejects.toThrow(/cc.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a CRLF in bcc throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({ ...buildMessage(), bcc: ["bcc@example.com\nBcc: victim@example.com"] }),
		).rejects.toThrow(/bcc.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("a CRLF in an attachment filename throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(
			mailer.send({
				...buildMessage(),
				attachments: [
					{
						filename: "invoice.pdf\r\nBcc: victim@example.com",
						content: "abc",
						contentType: "application/pdf",
					},
				],
			}),
		).rejects.toThrow(/attachments\.filename.*line break/);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("an empty to array after normalization throws without calling fetch", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await expect(mailer.send({ ...buildMessage(), to: [] })).rejects.toThrow(
			/at least one recipient \(to\)/,
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("sends fine with a single string to, as before (backward compatible)", async () => {
		const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
		const mailer = new RecordingFetchMailer(fetchFn);

		await mailer.send(buildMessage());

		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});
