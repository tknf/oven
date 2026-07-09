/**
 * Verifies `ConsoleMailer` (a `Mailer` implementation used as a development
 * fallback) (docs/testing.md L1). It never sends for real, only logs via
 * `console.log`, so this spies on `console.log` and checks the output.
 */
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { ConsoleMailer } from "../../src/mailer/console_mailer.js";

describe("ConsoleMailer", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("outputs from/to/subject/textBody to console.log", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await new ConsoleMailer().send({
			from: "no-reply@example.com",
			to: "listener@example.com",
			subject: "Test subject",
			textBody: "Body (assumed to include a verification URL)",
		});

		expect(logSpy).toHaveBeenCalledTimes(1);
		const output = logSpy.mock.calls[0]?.[0] as string;
		expect(output).toContain("From: no-reply@example.com");
		expect(output).toContain("To: listener@example.com");
		expect(output).toContain("Subject: Test subject");
		expect(output).toContain("Body (assumed to include a verification URL)");
	});

	test("outputs a message with cc/bcc/attachments without throwing", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await new ConsoleMailer().send({
			from: "no-reply@example.com",
			to: ["listener1@example.com", "listener2@example.com"],
			cc: "cc@example.com",
			bcc: ["bcc1@example.com", "bcc2@example.com"],
			subject: "Test subject",
			textBody: "Body",
			attachments: [
				{ filename: "invoice.pdf", content: "dummy-content", contentType: "application/pdf" },
			],
		});

		expect(logSpy).toHaveBeenCalledTimes(1);
		const output = logSpy.mock.calls[0]?.[0] as string;
		expect(output).toContain("To: listener1@example.com, listener2@example.com");
		expect(output).toContain("Cc: cc@example.com");
		expect(output).toContain("Bcc: bcc1@example.com, bcc2@example.com");
		expect(output).toContain("Attachments:");
		expect(output).toContain("invoice.pdf (application/pdf, 13 chars)");
		expect(output).not.toContain("dummy-content");
	});
});
