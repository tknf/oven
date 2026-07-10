/**
 * Cloudflare Email Sending adapter for `Mailer`. Takes a `SendEmail` binding
 * (a global type resolved by the host's `wrangler types` output, the same
 * pattern as `CloudflareKVStore` taking `KVNamespace`) via constructor
 * injection.
 *
 * `SendEmail.send()` has two overloads: one that takes a raw MIME
 * `EmailMessage` built via the `cloudflare:email` module, and one that takes
 * an `EmailMessageBuilder` of plain fields (`to`/`from`/`subject`/`text`/
 * `html`/`attachments`/...) and lets the binding compose the MIME itself.
 * This adapter always uses the latter (the builder form, which is
 * Cloudflare's documented, non-deprecated way to compose a message from
 * scratch). It avoids introducing raw MIME composition — new,
 * security-sensitive code this project doesn't otherwise need — and it keeps
 * this adapter importing nothing from `cloudflare:email`, so it can be
 * exercised by ordinary Node-based tests instead of requiring workerd.
 *
 * `EmailAttachment.content` must be a base64 string when a plain `string` is
 * passed (the binding does not treat a `string` as raw UTF-8 text). Any
 * `MailAttachment` with `encoding` other than `"base64"` is therefore
 * base64-encoded before being handed to the binding. Every attachment is
 * sent with `disposition: "attachment"`, since `MailMessage` has no
 * vocabulary for inline attachments.
 */
import {
	assertNoMailHeaderInjection,
	Mailer,
	type MailAttachment,
	type MailMessage,
	normalizeMailAddresses,
} from "../mailer/mailer.js";

/** Encodes `bytes` as a standard Base64 string (with `+`/`/` and `=` padding). */
const encodeBase64 = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);

	return btoa(binary);
};

/**
 * Converts a `MailAttachment`'s `content` into the base64 string the binding
 * requires. `"base64"`-encoded content is passed through as-is; otherwise the
 * UTF-8 text is encoded to bytes first (via `TextEncoder`, so non-ASCII text
 * survives) and then base64-encoded.
 */
const toBase64Content = (attachment: MailAttachment): string =>
	attachment.encoding === "base64"
		? attachment.content
		: encodeBase64(new TextEncoder().encode(attachment.content));

/** Converts `MailMessage.attachments` into the binding's `EmailAttachment[]` shape. */
const buildAttachments = (
	attachments: MailAttachment[] | undefined,
): EmailAttachment[] | undefined => {
	if (!attachments || attachments.length === 0) return undefined;

	return attachments.map((attachment) => ({
		disposition: "attachment",
		filename: attachment.filename,
		type: attachment.contentType,
		content: toBase64Content(attachment),
	}));
};

/** `Mailer` implementation backed by a Cloudflare Email Sending (`SendEmail`) binding. */
export class CloudflareEmailMailer extends Mailer {
	constructor(private readonly binding: SendEmail) {
		super();
	}

	async send(message: MailMessage): Promise<void> {
		assertNoMailHeaderInjection(message);

		const cc = normalizeMailAddresses(message.cc);
		const bcc = normalizeMailAddresses(message.bcc);

		const builder: EmailMessageBuilder = {
			from: message.from,
			to: normalizeMailAddresses(message.to),
			...(cc.length > 0 ? { cc } : {}),
			...(bcc.length > 0 ? { bcc } : {}),
			subject: message.subject,
			text: message.textBody,
			...(message.htmlBody !== undefined ? { html: message.htmlBody } : {}),
			...(message.attachments !== undefined
				? { attachments: buildAttachments(message.attachments) }
				: {}),
		};

		await this.binding.send(builder);
	}
}
