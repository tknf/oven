/**
 * `Mailer` implementation used as a development fallback. Instead of actually
 * sending mail, it logs the from/to/cc/bcc/subject/textBody/attachment summary
 * via `console.log`. Keeping important values (such as verification URLs) in
 * `textBody` lets you pick them up from the dev server logs to verify behavior.
 * The attachment `content` itself is never logged (to avoid bloating logs and
 * leaking sensitive data).
 */
import { Mailer, type MailMessage, normalizeMailAddresses } from "./mailer.js";

/** Development-only `Mailer` that logs messages to the console instead of sending them. */
export class ConsoleMailer extends Mailer {
	async send(message: MailMessage): Promise<void> {
		const lines = [
			"[ConsoleMailer] Mail send (development fallback)",
			`From: ${message.from}`,
			`To: ${normalizeMailAddresses(message.to).join(", ")}`,
		];

		if (message.cc !== undefined) {
			lines.push(`Cc: ${normalizeMailAddresses(message.cc).join(", ")}`);
		}
		if (message.bcc !== undefined) {
			lines.push(`Bcc: ${normalizeMailAddresses(message.bcc).join(", ")}`);
		}

		lines.push(`Subject: ${message.subject}`, "----", message.textBody);

		if (message.attachments !== undefined && message.attachments.length > 0) {
			lines.push("Attachments:");
			for (const attachment of message.attachments) {
				lines.push(
					`  ${attachment.filename} (${attachment.contentType}, ${attachment.content.length} chars)`,
				);
			}
		}

		console.log(lines.join("\n"));
	}
}
