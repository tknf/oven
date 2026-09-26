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
 * A cookie that needs integrity protection uses Hono's
 * `getSignedCookie`/`setSignedCookie` directly.
 */
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";

/** Cookie definition for `CookieAccessor`. */
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
