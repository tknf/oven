/**
 * Token-based CSRF protection, replacing `hono/csrf` (Origin / `Sec-Fetch-Site` validation).
 * Some browser/proxy environments don't send an Origin header, which makes origin-only
 * validation prone to false positives, so this uses a "session-bound secret + submitted
 * token match" scheme instead.
 *
 * The masking scheme XOR-masks with a one-time pad as a defense against BREACH attacks:
 * - The session holds exactly one raw `secret` (random 32 bytes).
 * - Each time a token is issued, a new one-time pad (32 bytes) is generated, and
 *   `pad || (pad XOR secret)` (64 bytes) is Base64URL-encoded and returned. Because the
 *   result differs on every call even for the same `secret`, an attacker cannot guess it
 *   from a fixed pattern in the response (BREACH).
 * - On verification, the submitted token is split back into `pad`/`secret` using the same
 *   procedure and compared against the session's `secret` in **constant time**.
 *
 * **Intentional exception when combined with `CookieSessionStorage`**: the CSRF secret
 * (`SESSION_SECRET_KEY`) is stored as-is as part of the session data, so when combined with
 * `CookieSessionStorage` (`cookie_session_storage.ts`) it ends up in the cookie as signed
 * plaintext. This is intentionally allowed. CSRF protection relies on the unforgeability of
 * the masked token (i.e. an attacker who doesn't know `secret` cannot craft a valid token),
 * and that assumption is "an attacker cannot read the victim's cookie value cross-site" —
 * not "the user themself cannot read their own cookie contents". Even if the user can read
 * their own CSRF secret, that doesn't let them forge tokens or impersonate anyone else, so
 * this is treated as an explicit, deliberate exception to the "don't store secrets" principle
 * defined in `cookie_session_storage.ts`.
 *
 * `session` is supplied via the constructor's `CsrfOptions` (`(c) => Session`, intended to be
 * the `use` accessor owned by `SessionAccessor`, passed through as-is). **Behavior when there
 * is no session**: CSRF assumes it runs downstream of the session accessor, so if the
 * `session` accessor itself hasn't been registered, it throws with a clear message (per the
 * contract of `SessionAccessor#use`). CSRF does not add any extra handling for this — a
 * misconfiguration where the session isn't wired up is safer to surface as close to startup
 * as possible, rather than silently letting CSRF verification slip through.
 */
import type { Context, Env, MiddlewareHandler } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import { constantTimeEqual } from "../support/constant_time.js";
import type { Session } from "../session/session.js";

/** An origin x path pair that is exempted from CSRF checks, for legitimate cross-site form posts (e.g. Apple OAuth callbacks). */
export type CsrfExceptionPath = { origin: string; path: string };

export type CsrfOptions<E extends Env> = {
	/** Session accessor. Pass `SessionAccessor`'s `use` through as-is. */
	session: (c: Context<E>) => Session;
	/**
	 * Exempts legitimate cross-site form posts (e.g. OAuth callbacks).
	 * Only exempted when both the `Origin` header and the request path match.
	 */
	exceptions?: CsrfExceptionPath[];
};

const SESSION_SECRET_KEY = "csrfSecret";
const SECRET_LENGTH_BYTES = 32;

/** Form field name that carries the CSRF token in a form submission. */
export const CSRF_FORM_FIELD_NAME = "csrf_token";
/** Header name that carries the CSRF token on non-form requests (e.g. `fetch`). */
export const CSRF_HEADER_NAME = "X-CSRF-Token";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Only look for a token in the body when the content-type indicates a form submission (same criteria as `hono/csrf`). */
const FORM_CONTENT_TYPE_RE = /^\b(application\/x-www-form-urlencoded|multipart\/form-data)\b/i;

/** Retrieves the CSRF secret held by the session, generating and storing (marking dirty) one if absent. */
const ensureSecret = (session: Session): Uint8Array => {
	const stored = session.get(SESSION_SECRET_KEY);
	if (typeof stored === "string") {
		try {
			return decodeBase64Url(stored);
		} catch {
			// Fall back to regenerating on a corrupted value (below).
		}
	}

	const secret = crypto.getRandomValues(new Uint8Array(SECRET_LENGTH_BYTES));
	session.set(SESSION_SECRET_KEY, encodeBase64Url(secret));
	return secret;
};

/** Returns a token string with `secret` masked using a fresh one-time pad. */
const maskToken = (secret: Uint8Array): string => {
	const pad = crypto.getRandomValues(new Uint8Array(secret.length));
	const masked = new Uint8Array(secret.length * 2);
	masked.set(pad, 0);
	for (let i = 0; i < secret.length; i++) {
		masked[secret.length + i] = pad[i] ^ secret[i];
	}
	return encodeBase64Url(masked);
};

/** Unmasks a masked token string using `secretLength` as the basis. Returns `null` on malformed input. */
const unmaskToken = (masked: string, secretLength: number): Uint8Array | null => {
	let bytes: Uint8Array;
	try {
		bytes = decodeBase64Url(masked);
	} catch {
		return null;
	}
	if (bytes.length !== secretLength * 2) return null;

	const secret = new Uint8Array(secretLength);
	for (let i = 0; i < secretLength; i++) {
		secret[i] = bytes[i] ^ bytes[secretLength + i];
	}
	return secret;
};

/** Extracts the submitted token, preferring the header and falling back to the form body. */
const extractSubmittedToken = async (c: Context): Promise<string | undefined> => {
	const header = c.req.header(CSRF_HEADER_NAME);
	if (header) return header;

	const contentType = c.req.header("content-type") ?? "";
	if (!FORM_CONTENT_TYPE_RE.test(contentType)) return undefined;

	const body = await c.req.parseBody();
	const value = body[CSRF_FORM_FIELD_NAME];
	return typeof value === "string" ? value : undefined;
};

/**
 * Provides the full CSRF protection toolkit: `verify` (validation middleware) and
 * `csrfToken` (token retrieval helper used by Form/Layout).
 */
export class Csrf<E extends Env> {
	private readonly useSession: (c: Context<E>) => Session;
	private readonly exceptions: CsrfExceptionPath[];

	constructor(options: CsrfOptions<E>) {
		this.useSession = options.session;
		this.exceptions = options.exceptions ?? [];
	}

	/** An arrow-function class field so it can be passed by reference from handlers/views (Form/Layout). */
	readonly csrfToken = (c: Context<E>): string => maskToken(ensureSecret(this.useSession(c)));

	/** An arrow-function class field so it can be passed by reference, e.g. `app.use(csrf.verify)`. */
	readonly verify: MiddlewareHandler<E> = createMiddleware<E>(async (c, next) => {
		if (SAFE_METHODS.has(c.req.method.toUpperCase())) {
			await next();
			return;
		}

		const origin = c.req.header("Origin");
		const isExempt =
			origin !== undefined &&
			this.exceptions.some(
				(exception) => exception.origin === origin && exception.path === c.req.path,
			);
		if (isExempt) {
			await next();
			return;
		}

		const secret = ensureSecret(this.useSession(c));
		const submitted = await extractSubmittedToken(c);
		const unmasked = submitted ? unmaskToken(submitted, secret.length) : null;

		if (!unmasked || !constantTimeEqual(unmasked, secret)) {
			throw new HTTPException(403, { message: "Invalid CSRF token" });
		}

		await next();
	});
}

/**
 * Returns the `<meta name="csrf-token">` tag string to inject into the base layout's `<head>`.
 * The framework only provides this building block; actually wiring it into the layout is the
 * application's responsibility (see the JSDoc in `layout.ts`).
 */
export const csrfMetaTag = (token: string): string =>
	`<meta name="csrf-token" content="${escapeHtmlAttribute(token)}">`;

const escapeHtmlAttribute = (value: string): string =>
	value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
