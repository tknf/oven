/**
 * Abstract base for mail send backends. Following the same policy as
 * `storage.ts` (`Storage`), it knows nothing about backend-specific types
 * (such as the destination API's request/response shape). Domain code
 * receives this via constructor injection (composition) and only holds
 * logic related to mail content, such as composing the subject and body.
 *
 * The only implementation oven itself provides is `ConsoleMailer`, used as a
 * development fallback. The actual send backend (an external mail delivery
 * API service, etc.) is built by the app extending this `Mailer` (the
 * framework doesn't ship implementations or factories tied to a specific
 * service, to stay consistent with the backend-agnostic principle).
 */

/**
 * A single attachment. `content` is always a `string` (when passing binary
 * data, base64-encode it and specify `encoding: "base64"`). Binary types
 * such as `Uint8Array` are avoided so that the whole `MailMessage` retains a
 * form that survives a `JSON.stringify` → `JSON.parse` round trip when
 * carried as a job payload on the queue.
 */
export type MailAttachment = {
	filename: string;
	content: string;
	/** How to interpret `content`. Defaults to `"utf8"`. Specify `"base64"` when passing binary data. */
	encoding?: "utf8" | "base64";
	contentType: string;
};

/**
 * The content of a single mail to send, in a common shape backends can
 * easily interpret. `from`/`subject`, every address in `to`/`cc`/`bcc`, and
 * each attachment's `filename`/`contentType` must not contain CR/LF (doing
 * so would enable mail header injection). `FetchMailer` validates this with
 * `assertNoMailHeaderInjection` at send time and throws if violated.
 * Implementations that extend `Mailer` directly should perform the same
 * validation.
 *
 * Since `MailMessage` is meant to be carried as a job payload on the queue,
 * it must strictly keep a form (JSON-serializable) that can be restored to
 * an identical value via a `JSON.stringify` → `JSON.parse` round trip. This
 * is why attachment `content` is a `string` rather than a `Uint8Array`.
 */
export type MailMessage = {
	from: string;
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	subject: string;
	textBody: string;
	htmlBody?: string;
	attachments?: MailAttachment[];
};

/**
 * Normalizes a recipient specification of the form
 * `string | string[] | undefined` into a `string[]`. `undefined` becomes an
 * empty array, a `string` becomes a single-element array, and an array is
 * returned as a shallow copy. Used as a shared building block when
 * `FetchMailer` subclasses convert to the destination API's shape.
 */
export const normalizeMailAddresses = (value: string | string[] | undefined): string[] => {
	if (value === undefined) return [];
	if (typeof value === "string") return [value];
	return [...value];
};

/**
 * Validates that none of `MailMessage`'s header-equivalent fields
 * (`from`/`subject`, every address in to/cc/bcc, and each attachment's
 * `filename`/`contentType`) contain CR (`\r`) or LF (`\n`). Throws if any do
 * (as a mail header injection countermeasure). Also throws if the
 * recipient (`to`) list is empty after normalization (unspecified or an
 * empty array), to prevent silently dropping a mail with no recipient.
 * `textBody`/`htmlBody` are body content, not expanded into raw headers, so
 * they're excluded from this check.
 */
export const assertNoMailHeaderInjection = (message: MailMessage): void => {
	const assertField = (label: string, value: string): void => {
		if (value.includes("\r") || value.includes("\n")) {
			throw new Error(
				`Mailer: ${label} must not contain a line break (CR/LF) (mail header injection countermeasure)`,
			);
		}
	};

	assertField("from", message.from);
	assertField("subject", message.subject);

	const to = normalizeMailAddresses(message.to);
	if (to.length === 0) {
		throw new Error("Mailer: at least one recipient (to) must be specified");
	}
	for (const address of to) assertField("to", address);
	for (const address of normalizeMailAddresses(message.cc)) assertField("cc", address);
	for (const address of normalizeMailAddresses(message.bcc)) assertField("bcc", address);

	for (const attachment of message.attachments ?? []) {
		assertField("attachments.filename", attachment.filename);
		assertField("attachments.contentType", attachment.contentType);
	}
};

/** Abstract base for mail send backends. */
export abstract class Mailer {
	/** Sends a single mail. Throws on failure. */
	abstract send(message: MailMessage): Promise<void>;
}
