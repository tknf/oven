/**
 * Development mail preview.
 * A `RouteHandler` subclass that takes an explicit table of "preview name →
 * factory returning a `MailMessage`" and exposes routes for listing and
 * viewing individual previews in the browser.
 *
 * Not mounting this in production is the app's responsibility (this handler
 * itself has no environment detection). Example:
 * ```ts
 * if (import.meta.env.DEV) {
 *   app.route(
 *     "/dev/mails",
 *     new MailPreviewHandler({
 *       previews: {
 *         welcome: () => ({ from: "no-reply@example.com", to: "test@example.com", subject: "Welcome", textBody: "..." }),
 *       },
 *     }),
 *   );
 * }
 * ```
 * It only builds and returns a `MailMessage` and doesn't depend on any
 * particular mail implementation (`Mailer`/`MailTemplate`), so `deliver`
 * (actual sending) never happens here.
 */
import { RouteHandler } from "../routing/route_handler.js";
import type { MailMessage } from "./mailer.js";
import { normalizeMailAddresses } from "./mailer.js";

/** Factory producing the `MailMessage` for a single preview name. May be async (`Promise`). */
export type MailPreviewFactory = () => MailMessage | Promise<MailMessage>;

/** Constructor options for `MailPreviewHandler`. */
export type MailPreviewHandlerOptions = {
	/** Table of preview name → `MailMessage` factory. Keys become the URL path segments as-is. */
	previews: Record<string, MailPreviewFactory>;
};

/** Escapes text embedded in a text node (only `&`, `<`, `>`; not for use in attribute values). */
const escapeHtmlText = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Formats `to` (`string | string[]`) into a comma-separated string for display. */
const formatAddresses = (value: string | string[] | undefined): string =>
	normalizeMailAddresses(value).join(", ");

/** Simple subject/recipient meta info block prepended to the HTML preview body. */
const htmlMetaBlock = (message: MailMessage): string =>
	`<div style="border-bottom:1px solid #ccc;margin-bottom:1em;padding-bottom:0.5em">` +
	`<p>Subject: ${escapeHtmlText(message.subject)}</p>` +
	`<p>To: ${escapeHtmlText(formatAddresses(message.to))}</p>` +
	`</div>`;

/** Simple subject/recipient meta info line prepended to the text preview body. */
const textMetaBlock = (message: MailMessage): string =>
	`Subject: ${message.subject}\nTo: ${formatAddresses(message.to)}\n\n`;

/** `RouteHandler` that exposes a listing and detail view for developer mail previews. */
export class MailPreviewHandler extends RouteHandler {
	/**
	 * Table of preview name → factory. `RouteHandler`'s wiring (the `register()`
	 * call) runs during the base constructor (`super()`), so subclass field
	 * initialization (which happens after `super()`) hasn't completed yet at
	 * that point (see constraint 2 in `src/routing/route_handler.ts`). Because
	 * of this, `register()` only registers the paths, and `this.previews` is
	 * always dereferenced at request time (inside the handler closure).
	 */
	private previews: Record<string, MailPreviewFactory> | undefined;

	constructor(options: MailPreviewHandlerOptions) {
		super();
		this.previews = options.previews;
	}

	protected register(): void {
		this.get("/", (c) => {
			const names = Object.keys(this.previews ?? {});
			const items = names
				.map((name) => `<li><a href="${encodeURIComponent(name)}">${escapeHtmlText(name)}</a></li>`)
				.join("");

			return c.html(
				`<!doctype html><html><head><meta charset="utf-8"><title>Mail Previews</title></head>` +
					`<body><h1>Mail Previews</h1><ul>${items}</ul></body></html>`,
			);
		});

		this.get("/:name", async (c) => {
			const previews = this.previews ?? {};
			const name = c.req.param("name");
			if (!Object.hasOwn(previews, name)) return c.notFound();
			const factory = previews[name];

			const message = await factory();
			const showText = c.req.query("part") === "text";

			if (!showText && message.htmlBody) {
				return c.html(`${htmlMetaBlock(message)}${message.htmlBody}`);
			}

			return c.text(`${textMetaBlock(message)}${message.textBody}`);
		});
	}
}
