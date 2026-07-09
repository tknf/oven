import { Mailer, type MailMessage, normalizeMailAddresses } from "../mailer/mailer.js";

/**
 * Test implementation of `Mailer`. Doesn't actually send anything; it simply
 * accumulates messages into `sent`. Used for asserting on sent message
 * content. Exported only from `src/test/index.ts`, not from the core
 * `src/index.ts` (since it's test-only).
 */
export class TestMailer extends Mailer {
	readonly sent: MailMessage[] = [];

	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
	}

	/** Returns sent messages that include `address` in to/cc/bcc. */
	sentTo(address: string): MailMessage[] {
		return this.sent.filter((message) => {
			const recipients = [
				...normalizeMailAddresses(message.to),
				...normalizeMailAddresses(message.cc),
				...normalizeMailAddresses(message.bcc),
			];
			return recipients.includes(address);
		});
	}

	/** Clears the accumulated send history (for cleanup between tests). */
	clear(): void {
		this.sent.length = 0;
	}
}
