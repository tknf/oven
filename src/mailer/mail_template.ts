/**
 * JSX template layer for mail. An abstract base that removes the need to
 * hand-write text/html duplicates and standardizes where the "compose
 * subject and body" domain logic lives.
 *
 * It connects to the send backend (`Mailer`) through composition: subclasses
 * only implement `subject`/`html` (required) and `text` (optional), and
 * `send()` builds a `MailMessage` and passes it to the injected
 * `Mailer#send`. `from` is also injected via the constructor (the sender
 * address is fixed per template instance; passing it through props would let
 * each caller change the sender, leaking information that should be fixed as
 * part of the domain).
 *
 * ## How htmlBody is generated (design decision)
 * The hono/jsx element type `JSX.Element` is
 * `HtmlEscapedString | Promise<HtmlEscapedString>` (confirmed in
 * `node_modules/hono/dist/types/jsx/base.d.ts`). `await` is required first:
 * async components such as `Suspense` may return the `Promise` branch, so
 * assuming it's always synchronous would break. Calling `.toString()`
 * explicitly is also required: `HtmlEscapedString` is a branded type
 * (`string & HtmlEscaped`) that looks like `string` at the type level, but at
 * runtime is a **boxed String object** created by `raw()`'s
 * `new String(value)` (confirmed in `node_modules/hono/dist/utils/html.js`),
 * so `typeof` remains `"object"`. Passing the `HtmlEscapedString` obtained
 * from `await` directly into `MailMessage.htmlBody` (typed as `string`) works
 * without issue for many operations (concatenation, JSON serialization,
 * etc.), but can break code relying on `typeof` checks or object identity.
 * So it's converted to a genuine primitive string with `.toString()` before
 * use (a boxed String's `.toString()` synchronously returns the original
 * string).
 *
 * ## textBody policy (design decision)
 * Comparing "mechanical derivation from html" against "an explicit
 * text-only method", **the explicit method is the default** (mechanical
 * derivation that depends on html's tag structure has weaker correctness
 * guarantees — for example, a link URL written only in an `<a>`'s `href`
 * attribute would be lost from the text version). However, when the
 * explicit method is omitted (so simple notification emails aren't forced
 * into duplicate implementations), it falls back to a simple derivation
 * (`deriveTextFromHtml`) that converts block-element closing tags and
 * `<br>` into newlines before stripping tags. The fallback is a simple
 * implementation that doesn't fully decode HTML entities or expand `href`
 * attributes, so if you want to surface a link's URL in the text version
 * too, include the plain URL in the body text (as done in the current
 * `MagicLinkMailer`).
 */
import type { JSX } from "hono/jsx/jsx-runtime";
import { Mailer } from "./mailer.js";

/** Pattern matching block-level closing tags and `<br>`, used to convert them into newlines for the text version. */
const BLOCK_BREAK_PATTERN = /<\/(?:p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi;

/** Decodes the main HTML entity references back to plain text (`&amp;` is processed last so it doesn't corrupt other entities). */
const decodeHtmlEntities = (value: string): string =>
	value
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&");

/**
 * Mechanically derives a text version from `htmlBody` (fallback used when
 * `text()` is omitted; see "textBody policy" in the class comment above).
 * Processes in order: convert block elements/`<br>` to newlines → strip all
 * tags → decode entities → collapse consecutive blank lines into one.
 */
const deriveTextFromHtml = (html: string): string => {
	const withBreaks = html.replace(BLOCK_BREAK_PATTERN, "\n");
	const withoutTags = withBreaks.replace(/<[^>]+>/g, "");
	const decoded = decodeHtmlEntities(withoutTags);

	const collapsed: string[] = [];
	for (const rawLine of decoded.split("\n")) {
		const line = rawLine.trim();
		if (line === "" && collapsed[collapsed.length - 1] === "") continue;
		collapsed.push(line);
	}

	return collapsed.join("\n").trim();
};

/** Abstract base for JSX-based mail templates that compose a subject and body from `props`. */
export abstract class MailTemplate<TProps> {
	constructor(
		private readonly mailer: Mailer,
		private readonly from: string,
	) {}

	/** Builds the mail subject from `props`. */
	protected abstract subject(props: TProps): string;

	/** Builds the mail body (HTML version) from `props` as JSX. */
	protected abstract html(props: TProps): JSX.Element;

	/**
	 * Explicitly builds the mail body (text version) from `props`. When
	 * omitted (returns `null`), it's mechanically derived from the result of
	 * `html()` via `deriveTextFromHtml` (see class comment).
	 */
	protected text(_props: TProps): string | null {
		return null;
	}

	/** Sends the mail built from this template to `to`. */
	async send(to: string, props: TProps): Promise<void> {
		const htmlBody = (await this.html(props)).toString();
		const textBody = this.text(props) ?? deriveTextFromHtml(htmlBody);

		await this.mailer.send({
			from: this.from,
			to,
			subject: this.subject(props),
			textBody,
			htmlBody,
		});
	}
}
