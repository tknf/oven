/**
 * Token issuance and verification for "remember me" (keeping a login state alive).
 *
 * **Why the selector/validator scheme is used**: if the cookie value were a
 * single plain random token, the store would have to hold either "the token
 * itself" or "a hash of the token". The former lets an attacker reuse the
 * token directly the moment the store leaks; the latter cannot narrow the
 * lookup to a single candidate via `store.get` (a hash cannot be reversed into
 * its key), requiring a full scan. The selector/validator scheme splits the
 * cookie value into two parts, `${selector}.${validator}`: `selector` is kept
 * in plaintext and used as the store lookup key (`${prefix}${selector}`), while
 * only the hash (SHA-256) of `validator` is stored. This achieves both:
 * - store lookup stays an O(1) `get` by `selector`
 * - even if the store alone leaks, the cookie cannot be reused (impersonation)
 *   unless the plaintext `validator` can be recovered from the leaked hash
 *
 * The token is **rotated on every use** (on a successful `consume`, the old
 * `selector`'s store entry is deleted and a new token is reissued). This is
 * standard practice for reducing the risk of interception/replay by never
 * having the same token sent repeatedly over the network.
 *
 * A `validator` hash mismatch means an incorrect `validator` was presented for
 * a legitimate `selector`, which can also be a sign of cookie theft or brute
 * force. Rather than just returning `null`, that store entry itself is also
 * invalidated (treated the same as expiry), making a token unusable again
 * after even a single mismatch.
 */
import type { Context, Env } from "hono";
import type { CookieOptions } from "hono/utils/cookie";
import { decodeBase64Url } from "../support/base64url.js";
import { constantTimeEqual } from "../support/constant_time.js";
import { CookieAccessor } from "../support/cookie.js";
import { warnInsecureCookieInProduction } from "../support/cookie_security_warning.js";
import type { KeyValueStore } from "../kv/key_value_store.js";
import {
	hashValidator,
	randomToken,
	SELECTOR_BYTE_LENGTH,
	VALIDATOR_BYTE_LENGTH,
} from "./selector_validator.js";

export type RememberTokenOptions = {
	/** The `KeyValueStore` that stores the token hash. */
	store: KeyValueStore;
	/** Token validity period in seconds. Default 30 days (`2_592_000`). */
	ttlSeconds?: number;
	/** Cookie name. Default `"remember_token"`. */
	cookieName?: string;
	/** Store key prefix. Default `"remember:"`. */
	prefix?: string;
	/**
	 * Cookie attributes. Defaults to `path: "/"`, `httpOnly: true`,
	 * `sameSite: "Lax"`, `maxAge: ttlSeconds`. `secure` has no default (the same
	 * policy as `session.ts`; in production, the caller should explicitly set
	 * `true`). Values specified here override all defaults.
	 */
	cookie?: CookieOptions;
};

/** The value stored in the store. Holds only `validatorHash`; the plaintext `validator` itself is never stored. */
type StoredToken = {
	identity: string;
	validatorHash: string;
	/**
	 * The exact expiry time (Unix milliseconds). A TTL is also passed to
	 * `store.set`, but per `key_value_store.ts`'s contract, the exact expiry
	 * check is performed against this absolute time.
	 */
	expiresAt: number;
};

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_COOKIE_NAME = "remember_token";
const DEFAULT_PREFIX = "remember:";

/** Validates the raw value read back from the store as a `StoredToken` and returns it. Returns `null` if malformed. */
const parseStoredToken = (raw: string | null): StoredToken | null => {
	if (!raw) return null;

	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"identity" in parsed &&
			"validatorHash" in parsed &&
			"expiresAt" in parsed &&
			typeof parsed.identity === "string" &&
			typeof parsed.validatorHash === "string" &&
			typeof parsed.expiresAt === "number"
		) {
			return {
				identity: parsed.identity,
				validatorHash: parsed.validatorHash,
				expiresAt: parsed.expiresAt,
			};
		}
		return null;
	} catch {
		return null;
	}
};

/** Splits a cookie value `${selector}.${validator}`. Returns `null` if there is no separator. */
const splitCookieValue = (value: string): { selector: string; validator: string } | null => {
	const separatorIndex = value.indexOf(".");
	if (separatorIndex === -1) return null;

	return {
		selector: value.slice(0, separatorIndex),
		validator: value.slice(separatorIndex + 1),
	};
};

/**
 * Issues, verifies, and revokes remember-me (login-state-persistence) tokens.
 * `issue`/`consume`/`forget` are all declared as arrow-function class fields
 * because they may be passed by reference from handlers/`Guard`.
 */
export class RememberToken<E extends Env> {
	private readonly store: KeyValueStore;
	private readonly ttlSeconds: number;
	private readonly prefix: string;
	private readonly cookie: CookieAccessor;

	constructor(options: RememberTokenOptions) {
		this.store = options.store;
		this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
		this.prefix = options.prefix ?? DEFAULT_PREFIX;

		const cookieOptions: CookieOptions = {
			path: "/",
			httpOnly: true,
			sameSite: "Lax",
			maxAge: this.ttlSeconds,
			...options.cookie,
		};
		warnInsecureCookieInProduction(cookieOptions.secure, "RememberToken");
		this.cookie = new CookieAccessor({
			name: options.cookieName ?? DEFAULT_COOKIE_NAME,
			options: cookieOptions,
		});
	}

	/** Issues a new token for `identity`, saving it to the store and writing it to the cookie. */
	readonly issue = async (c: Context<E>, identity: string): Promise<void> => {
		const selector = randomToken(SELECTOR_BYTE_LENGTH);
		const validator = randomToken(VALIDATOR_BYTE_LENGTH);
		const validatorHash = await hashValidator(validator);
		const expiresAt = Date.now() + this.ttlSeconds * 1000;

		const stored: StoredToken = { identity, validatorHash, expiresAt };
		await this.store.set(`${this.prefix}${selector}`, JSON.stringify(stored), this.ttlSeconds);
		this.cookie.set(c, `${selector}.${validator}`);
	};

	/**
	 * Verifies the cookie's token and, on success, returns `identity`. On
	 * success, the token is always rotated (deleting the old `selector`'s store
	 * entry and reissuing via `issue`).
	 *
	 * On failure (no cookie, malformed format, missing store entry, `validator`
	 * hash mismatch, or expiry), returns `null`. Since a hash mismatch can also
	 * be a sign of theft, the corresponding store entry is invalidated (the same
	 * as on expiry) and the cookie is also deleted.
	 */
	readonly consume = async (c: Context<E>): Promise<string | null> => {
		const cookieValue = this.cookie.get(c);
		if (!cookieValue) return null;

		const parts = splitCookieValue(cookieValue);
		if (!parts) {
			this.cookie.delete(c);
			return null;
		}

		const key = `${this.prefix}${parts.selector}`;
		const stored = parseStoredToken(await this.store.get(key));
		if (!stored) {
			this.cookie.delete(c);
			return null;
		}

		const validatorHash = await hashValidator(parts.validator);
		let hashMatches: boolean;
		try {
			hashMatches = constantTimeEqual(
				decodeBase64Url(validatorHash),
				decodeBase64Url(stored.validatorHash),
			);
		} catch {
			hashMatches = false;
		}
		const notExpired = stored.expiresAt > Date.now();

		if (!hashMatches || !notExpired) {
			await this.store.delete(key);
			this.cookie.delete(c);
			return null;
		}

		await this.store.delete(key);
		await this.issue(c, stored.identity);
		return stored.identity;
	};

	/** For logout. Deletes both the store entry and the cookie. */
	readonly forget = async (c: Context<E>): Promise<void> => {
		const cookieValue = this.cookie.get(c);
		const parts = cookieValue ? splitCookieValue(cookieValue) : null;
		if (parts) {
			await this.store.delete(`${this.prefix}${parts.selector}`);
		}

		this.cookie.delete(c);
	};
}
