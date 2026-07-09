/**
 * Typed accessor layer for cookies.
 *
 * Hono's cookie helpers (`hono/cookie`, including the signed
 * `getSignedCookie`/`setSignedCookie`) are already a sufficient abstraction
 * on their own, so this module only adds a thin class that bundles "one
 * cookie name + default `CookieOptions`" into a typed accessor
 * (`get`/`set`/`delete`). Managing the lifecycle of a session value (storing
 * it, initializing it) is not this layer's responsibility — that belongs to
 * SessionStorage's "auto-commit at the end of a request" role. This module
 * only provides a way to read/write a single named cookie.
 *
 * **Why signed and unsigned are split into separate classes**: Hono's signed
 * API (`getSignedCookie`/`setSignedCookie`) is asynchronous (it uses the Web
 * Crypto API to compute the HMAC signature), while the unsigned API is
 * synchronous. Representing both in a single class would require overriding
 * `get`/`set` with different return types, and forcing that unification
 * through inheritance would make derived classes incompatible with the base
 * signature (violating the Liskov substitution principle). So this module
 * exposes two independent classes distinguished by name:
 * `CookieAccessor` (unsigned) and `SignedCookieAccessor` (signed). This
 * convention of naming classes explicitly per use case is consistent with
 * how this framework distinguishes `Session`/`AdminSession` via inheritance.
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, getSignedCookie, setCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

/** Cookie definition shared by `CookieAccessor`/`SignedCookieAccessor`. */
export interface CookieDefinition {
	/** Cookie name. */
	readonly name: string;
	/** Default `CookieOptions` applied to both `set` and `delete`. */
	readonly options?: CookieOptions;
}

/**
 * Typed accessor for an unsigned cookie. `definition.options` is applied as
 * the default for both `set` and `delete` (so callers don't have to repeat
 * the attributes each time — this collects the existing app's hand-written
 * pattern of "constant-ify cookie attributes and pass them to both
 * `setCookie`/`deleteCookie`" into one class).
 */
export class CookieAccessor {
	constructor(private readonly definition: CookieDefinition) {}

	/** Reads the cookie value. Returns `undefined` if not present. */
	get(c: Context): string | undefined {
		return getCookie(c, this.definition.name);
	}

	/** Writes the cookie value (using `definition.options` as default attributes). */
	set(c: Context, value: string): void {
		setCookie(c, this.definition.name, value, this.definition.options);
	}

	/** Deletes the cookie. Returns the value it had before deletion, if any. */
	delete(c: Context): string | undefined {
		return deleteCookie(c, this.definition.name, this.definition.options);
	}
}

/** Cookie definition for `SignedCookieAccessor`. `secret` is the shared key used to sign and verify. */
export interface SignedCookieDefinition extends CookieDefinition {
	/** Secret key used for HMAC signing (same type as `hono/cookie`'s `getSignedCookie`/`setSignedCookie`). */
	readonly secret: string | BufferSource;
}

/**
 * Typed accessor for a signed cookie. `get`/`set` both return a `Promise`
 * because Hono's signed API is always asynchronous (it signs using the Web
 * Crypto API). `get` returns `undefined` when the cookie is not present, and
 * `false` when signature verification fails (i.e., the cookie was tampered
 * with), matching `hono/cookie`'s type definitions. Callers may treat both
 * cases as "not a valid value", but can distinguish them with `=== false`
 * if needed.
 */
export class SignedCookieAccessor {
	constructor(private readonly definition: SignedCookieDefinition) {}

	/** Reads and verifies the signed cookie value. Returns `undefined` if unset, `false` if tampering is detected. */
	get(c: Context): Promise<string | undefined | false> {
		return getSignedCookie(c, this.definition.secret, this.definition.name);
	}

	/** Signs `value` and writes it to the cookie. */
	async set(c: Context, value: string): Promise<void> {
		await setSignedCookie(
			c,
			this.definition.name,
			value,
			this.definition.secret,
			this.definition.options,
		);
	}

	/** Deletes the cookie (no signature verification needed for deletion, so this is synchronous). Returns the previous value. */
	delete(c: Context): string | undefined {
		return deleteCookie(c, this.definition.name, this.definition.options);
	}
}
