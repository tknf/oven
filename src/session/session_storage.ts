/**
 * The abstract base class for `SessionStorage`.
 *
 * **Abstract base class vs. interface**: the method contract is "interface-like" in
 * nature, but following oven's single idiom (Session/Storage/Mailer/Model/
 * RouteHandler are all unified as abstract base class + inheritance), this is an
 * **abstract base class**. Two reasons:
 * 1. Because "sliding TTL is an optional feature provided by the base class", the
 *    base class needs to hold behavior (cookie name, resolving default cookie
 *    options), which an interface cannot do.
 * 2. Every other layer (`Storage` in `storage.ts`, `Mailer` in `mailer.ts`, `Logger`
 *    in `logger.ts`, etc.) is unified as an abstract base class; making
 *    `SessionStorage` alone an interface would break the value of the single idiom
 *    ("the same vocabulary is used everywhere in the framework").
 *
 * Contract (the same semantics as `createSessionStorage`):
 * - `get(cookieHeader)`: restores a `Session` from a cookie header string. Even if the
 *   header is missing, malformed, or no corresponding data is found, this must not
 *   throw — it returns an empty `Session` (so the caller can naturally represent
 *   "not logged in" and similar states).
 * - `commit(session)`: persists the session and returns the value that should be set
 *   on the `Set-Cookie` header (the same string form returned by `hono/cookie`'s
 *   `generateCookie`).
 * - `destroy(session)`: destroys the session and returns the deletion (`Max-Age=0`)
 *   `Set-Cookie` value.
 */
import { generateCookie } from "hono/cookie";
import { parse } from "hono/utils/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { warnInsecureCookieInProduction } from "../support/cookie_security_warning.js";
import type { Session } from "./session.js";

/** Attributes of the cookie managed by `SessionStorage` itself. Defaults `name` to `"session"` if omitted. */
export type SessionCookieOptions = CookieOptions & { name?: string };

const DEFAULT_COOKIE_NAME = "session";

/**
 * Default cookie attribute values. `secure: true` is not hardcoded, since that would
 * break local HTTP development (`secure` has no default and, in production, the
 * caller must explicitly pass `true`).
 *
 * `sameSite` defaults to `"Lax"`. Leaving it unspecified and relying on the browser's
 * default behavior would cause Chrome (which treats it as Lax) and Safari/Firefox
 * (which are more permissive) to actually send cookies under different conditions,
 * leaving some environments not on the safe side for a session-cookie use case.
 * Always overridable via `SessionCookieOptions` (e.g. if a cross-origin form_post
 * integration is needed, the caller can specify `"None"`).
 */
const DEFAULT_COOKIE_OPTIONS: CookieOptions = {
	path: "/",
	httpOnly: true,
	sameSite: "Lax",
};

export abstract class SessionStorage {
	/** The cookie name (`"session"` if `options.name` is omitted). */
	protected readonly cookieName: string;

	/** Cookie attributes excluding `name` (in the form directly passable to `generateCookie`). */
	protected readonly cookieOptions: CookieOptions;

	constructor(options: SessionCookieOptions = {}) {
		const { name, ...cookieOptions } = options;
		this.cookieName = name ?? DEFAULT_COOKIE_NAME;
		this.cookieOptions = { ...DEFAULT_COOKIE_OPTIONS, ...cookieOptions };
		warnInsecureCookieInProduction(this.cookieOptions.secure, this.constructor.name);
	}

	/**
	 * Restores a `Session` from a cookie header string (`c.req.header("Cookie")`, or
	 * `null` if absent). Must not throw on failure; returns an empty `Session`
	 * instead.
	 */
	abstract get(cookieHeader: string | null): Promise<Session>;

	/** Persists `session` and returns the value to set on the `Set-Cookie` header. */
	abstract commit(session: Session): Promise<string>;

	/** Destroys `session` and returns the deletion (`Max-Age=0`) `Set-Cookie` value. */
	abstract destroy(session: Session): Promise<string>;

	/**
	 * Extracts the raw value (the session id, or, for backends where the cookie
	 * itself is the data, the payload string) of the cookie this storage manages
	 * (`cookieName`) from a cookie header string. Returns `undefined` if absent.
	 *
	 * All four concrete implementations (Cookie/InMemory/KeyValue/Database) used to
	 * duplicate the logic for "read only the cookie with our own name from the cookie
	 * header" verbatim, so it is consolidated here.
	 */
	protected readSessionCookie(cookieHeader: string | null): string | undefined {
		return cookieHeader ? parse(cookieHeader, this.cookieName)[this.cookieName] : undefined;
	}

	/**
	 * Builds the `Set-Cookie` value returned by `commit`, using this storage's cookie
	 * name and attributes.
	 *
	 * Since the attribute policy (resolving `cookieOptions` defaults) lives in the
	 * base class, building the cookie value itself must also be consolidated here —
	 * otherwise changing the attribute policy would require fixing all four
	 * subclasses individually (if the logout cookie's — i.e. `buildDestroyCookie`'s —
	 * attributes do not match those used when it was set, the browser will not delete
	 * the original cookie. Attributes must always take effect consistently across all
	 * backends from a single change).
	 */
	protected buildCommitCookie(value: string): string {
		return generateCookie(this.cookieName, value, this.cookieOptions);
	}

	/**
	 * Builds the deletion (`Max-Age=0`, `Expires` in the past) `Set-Cookie` value
	 * returned by `destroy`. Consolidated here for the same reason as
	 * `buildCommitCookie`.
	 */
	protected buildDestroyCookie(): string {
		return generateCookie(this.cookieName, "", {
			...this.cookieOptions,
			maxAge: 0,
			expires: new Date(0),
		});
	}
}

/**
 * Generates a high-entropy random string used as a session id for KV/DB backends.
 * The same approach (256-bit, hex) as `Session.generateToken` in
 * `src/adapters/session.ts`.
 *
 * Does not use `IdGenerator` (`@tknf/snowflake`, `id_generator.ts`): Snowflake is
 * designed to cheaply issue sortable unique identifiers, and even in `mode: "edge"`
 * it has only around 22 bits of entropy. A session id must be "unguessable" as a
 * security requirement in itself, so the two forms of id generation serve different
 * purposes and are used accordingly.
 */
export const generateSessionId = (): string => {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};
