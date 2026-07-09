import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { DefaultCatalog, Translate } from "../i18n/i18n.js";
import { defaultTranslator } from "../i18n/i18n.js";
import type { Logger } from "../logging/logger.js";

/**
 * Class providing the `onError` convention and a shared error page.
 *
 * Status-code conventions established by this module (not enforced in code, documented
 * as a convention):
 * - A successful form submission returns 303 (PRG)
 * - Validation failure returns 422
 * - Rate limit exceeded returns 429
 * - "Not found" and "forbidden" are unified into the same 404 (to prevent information
 *   disclosure — a third party should not be able to infer whether the target exists)
 *
 * JSON-returning API sub-apps (e.g. signed URL issuance — endpoints that return only
 * values, not part of the UI) are expected to override `onError` themselves and return
 * JSON errors, rather than using this class.
 *
 * The 404/500 copy is looked up from `i18n.ts`'s default instance (`defaultTranslator`).
 * Passing `options.t` (an app-specific translate function — the `t` of a `Translator<C>`
 * instance, where `C` includes the `"errors.notFound"`/`"errors.serverError"` keys) lets
 * you replace the copy; if omitted, `defaultTranslator.t` is used with its default text.
 *
 * Usage: `const errors = new ErrorPages({...}); app.onError(errors.onError); app.notFound(errors.notFound);`
 */
export class ErrorPages {
	private readonly logger?: (c: Context) => Logger;
	private readonly t: Translate<DefaultCatalog>;

	constructor(options?: { logger?: (c: Context) => Logger; t?: Translate<DefaultCatalog> }) {
		this.logger = options?.logger;
		this.t = options?.t ?? defaultTranslator.t;
	}

	/**
	 * Passed by reference to `app.onError`, so it is a class-field arrow function.
	 *
	 * Setting `onError` disables Hono's default `HTTPException` handling (which normally
	 * returns `err.getResponse()` automatically), so the `err instanceof HTTPException`
	 * branch is required (this behavior is documented in Hono's official "Error Handling"
	 * docs).
	 *
	 * When `logger` is provided, a generic (non-`HTTPException`) error triggers a
	 * structured log via `logger(c).error(...)` (message, stack, method, path, and
	 * `requestId` if `c.get("requestId")` is set). Error details (message, stack) are
	 * never included in the response (to prevent information disclosure).
	 */
	readonly onError: ErrorHandler = (err, c) => {
		if (err instanceof HTTPException) return err.getResponse();

		if (this.logger) {
			const fields: Record<string, unknown> = {
				stack: err.stack,
				method: c.req.method,
				path: c.req.path,
			};
			const requestId = c.get("requestId");
			if (typeof requestId === "string") fields.requestId = requestId;

			this.logger(c).error(err.message, fields);
		}

		return c.html(errorPage(resolveLang(c), 500, this.t(c, "errors.serverError")), 500);
	};

	/**
	 * Passed by reference to `app.notFound`, so it is a class-field arrow function.
	 * Returns the shared error page in accordance with the current policy of unifying
	 * "not found" and "forbidden" into the same 404 (see the class-level JSDoc).
	 */
	readonly notFound: NotFoundHandler = (c) =>
		c.html(errorPage(resolveLang(c), 404, this.t(c, "errors.notFound")), 404);
}

/**
 * The format allowed for the `<html lang>` attribute (loosely permits a valid BCP 47
 * range: ASCII alphanumerics and hyphens only, up to 35 characters). Since RFC 5646
 * language tags themselves consist only of ASCII alphanumerics and hyphens, a valid
 * language code can never contain characters outside this range (quotes, angle
 * brackets, etc.).
 */
const LANG_ATTRIBUTE_RE = /^[A-Za-z0-9-]{1,35}$/;

/**
 * Resolves the language code used for `<html lang>`. If `languageDetector` (from
 * `hono/language`) has run and called `c.set("language", lang)`, uses that value;
 * otherwise falls back to `"en"` (see `i18n.ts`'s JSDoc), matching the default
 * translator's English fallback.
 *
 * `c.get("language")` is expected to hold the language code detected by
 * `languageDetector` (from `hono/language`), but since that value is embedded directly
 * into the `<html lang="...">` attribute without escaping, it is validated against the
 * `LANG_ATTRIBUTE_RE` allowlist so that a miswired middleware (e.g. one that calls
 * `c.set("language", ...)` with user-supplied input) cannot achieve attribute injection.
 * Since a valid language code can never fall outside this format, an allowlist (falling
 * back to the safe `"en"` on mismatch) is used instead of escaping.
 */
const resolveLang = (c: Context): string => {
	const language = c.get("language");
	return typeof language === "string" && LANG_ATTRIBUTE_RE.test(language) ? language : "en";
};

/** Escapes text embedded in a text node (`&`, `<`, `>` only — not for use in attribute values). */
const escapeHtmlText = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The shared error page (minimal semantic HTML). The message text is provided by the caller. */
const errorPage = (lang: string, status: number, message: string): string => {
	const safeMessage = escapeHtmlText(message);
	return `<!doctype html>
<html lang="${lang}">
	<head>
		<meta charset="utf-8" />
		<title>${status} - ${safeMessage}</title>
	</head>
	<body>
		<main>
			<h1>${safeMessage}</h1>
		</main>
	</body>
</html>`;
};
