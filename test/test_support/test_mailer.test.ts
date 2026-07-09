/**
 * Verifies `TestMailer`, the test `Mailer` implementation provided by `@tknf/oven/test`.
 * Confirms `send` does not throw and accumulates into `sent`, and that `clear()` clears history.
 */
import { describe, expect, test } from "vite-plus/test";
import { TestMailer } from "../../src/test/test_mailer.js";

describe("TestMailer", () => {
	test("sent content accumulates in sent", async () => {
		const mailer = new TestMailer();

		await mailer.send({
			from: "from@example.com",
			to: "to@example.com",
			subject: "Test subject",
			textBody: "Body",
		});

		expect(mailer.sent).toEqual([
			{ from: "from@example.com", to: "to@example.com", subject: "Test subject", textBody: "Body" },
		]);
	});

	test("clear() clears the send history", async () => {
		const mailer = new TestMailer();
		await mailer.send({ from: "a@example.com", to: "b@example.com", subject: "s", textBody: "t" });

		mailer.clear();

		expect(mailer.sent).toEqual([]);
	});

	test("sentTo returns messages matching to", async () => {
		const mailer = new TestMailer();
		const message = {
			from: "from@example.com",
			to: "to@example.com",
			subject: "Test subject",
			textBody: "Body",
		};
		await mailer.send(message);

		expect(mailer.sentTo("to@example.com")).toEqual([message]);
	});

	test("sentTo returns messages matching cc", async () => {
		const mailer = new TestMailer();
		const message = {
			from: "from@example.com",
			to: "to@example.com",
			cc: ["cc1@example.com", "cc2@example.com"],
			subject: "Test subject",
			textBody: "Body",
		};
		await mailer.send(message);

		expect(mailer.sentTo("cc2@example.com")).toEqual([message]);
	});

	test("sentTo returns messages matching bcc", async () => {
		const mailer = new TestMailer();
		const message = {
			from: "from@example.com",
			to: "to@example.com",
			bcc: "bcc@example.com",
			subject: "Test subject",
			textBody: "Body",
		};
		await mailer.send(message);

		expect(mailer.sentTo("bcc@example.com")).toEqual([message]);
	});

	test("sentTo returns an empty array when there is no match", async () => {
		const mailer = new TestMailer();
		await mailer.send({
			from: "from@example.com",
			to: "to@example.com",
			subject: "Test subject",
			textBody: "Body",
		});

		expect(mailer.sentTo("other@example.com")).toEqual([]);
	});
});
