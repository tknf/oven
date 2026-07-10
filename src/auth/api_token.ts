/**
 * API token authentication using a minimal, self-issued bearer-token scheme.
 *
 * **Why the selector/validator scheme is used**: same reasoning as `remember_token.ts`.
 * Of the token string `${selector}.${validator}`, `selector` is stored in plaintext
 * as the DB lookup key, and only the SHA-256 hash of `validator` is stored. This
 * means that even if the DB leaks, the token cannot be reproduced unless the
 * plaintext `validator` can be recovered from the hash, and verification only
 * needs an O(1) lookup by `selector` (no need to compare `validatorHash` against
 * every row).
 *
 * **Unlike `RememberToken`, this does not rotate**. Rotating on every use makes
 * sense for remember-me tokens because they are sent as a browser cookie on
 * every request, so reissuing them each time reduces the risk of interception
 * and replay. API tokens, on the other hand, are meant to be kept unchanged for
 * a long time by API clients (CLIs, server-to-server integrations, etc.) in
 * config files or environment variables; if the value changed on every
 * verification the caller could not keep up. So an API token is simply matched
 * against the value captured at `issue` time on every verification, with no
 * rotation (revocation is left to the application, e.g. by deleting the record).
 *
 * Managing abilities/scopes (which operations a token is allowed to perform) is
 * outside this class's responsibility. When the application stores the
 * `selector`/`validatorHash` returned by `issue` into its own token table, it is
 * free to add extra columns (e.g. `abilities`).
 *
 * Extracting the token from `Authorization: Bearer <token>` and rejecting the
 * request when it's missing/invalid is exactly what Hono's own
 * `hono/bearer-auth` already does, so `ApiToken` is meant to plug into its
 * `verifyToken` option rather than a hand-rolled header parse:
 * ```ts
 * import { bearerAuth } from "hono/bearer-auth";
 *
 * const apiToken = new ApiToken({ prefix: "oven_" });
 * app.use(
 *   bearerAuth({
 *     verifyToken: async (token, c) => {
 *       const record = await apiToken.verify(token, (selector) =>
 *         db.apiTokens.findBySelector(selector),
 *       );
 *       if (!record) return false;
 *       c.set("apiTokenRecord", record);
 *       return true;
 *     },
 *   }),
 * );
 * ```
 * `verifyToken` returns a `boolean` (not the record itself), so the record is
 * stashed onto `c` from inside the callback for downstream handlers to read.
 * Resolving the token's subject (e.g. a user) from `record` via `provider` is the
 * application's responsibility.
 */
import { decodeBase64Url } from "../support/base64url.js";
import { constantTimeEqual } from "../support/constant_time.js";
import {
	hashValidator,
	randomToken,
	SELECTOR_BYTE_LENGTH,
	VALIDATOR_BYTE_LENGTH,
} from "./selector_validator.js";

export type ApiTokenOptions = {
	/** Identifying prefix placed at the start of the token string (e.g. `"oven_"`, for secret-scanning support and visual identification). Default `""`. */
	prefix?: string;
};

export type IssuedApiToken = {
	/** The plaintext token handed to the client exactly once (`prefix + selector + "." + validator"`). Never stored. */
	token: string;
	/** The value stored as the DB lookup key. */
	selector: string;
	/** The SHA-256 hash of `validator` (base64url). Only this is stored in the DB. */
	validatorHash: string;
};

const DEFAULT_PREFIX = "";

/**
 * Issues and verifies API tokens. `issue`/`verify` are declared as arrow-function
 * class fields because they may be passed by reference to handlers/`Guard`.
 */
export class ApiToken {
	private readonly prefix: string;

	constructor(options?: ApiTokenOptions) {
		this.prefix = options?.prefix ?? DEFAULT_PREFIX;
	}

	/**
	 * Issues a new token. The caller must store `selector`/`validatorHash` in its
	 * own token table; `token` is returned only as this issuance response
	 * (it is never persisted afterwards).
	 */
	readonly issue = async (): Promise<IssuedApiToken> => {
		const selector = randomToken(SELECTOR_BYTE_LENGTH);
		const validator = randomToken(VALIDATOR_BYTE_LENGTH);
		const validatorHash = await hashValidator(validator);

		return {
			token: `${this.prefix}${selector}.${validator}`,
			selector,
			validatorHash,
		};
	};

	/**
	 * Verifies a token string. `lookup` is a callback that resolves a record
	 * (containing `validatorHash`) from `selector` (returning `null`/`undefined`
	 * if not found).
	 *
	 * On success, returns the record `lookup` returned as-is. Any failure
	 * (prefix mismatch, malformed format, unknown selector, validatorHash
	 * mismatch) returns `null` without distinguishing the cause (fail-soft;
	 * distinguishing the cause would give an attacker clues for token discovery).
	 */
	readonly verify = async <TRecord extends { validatorHash: string }>(
		token: string,
		lookup: (selector: string) => TRecord | null | undefined | Promise<TRecord | null | undefined>,
	): Promise<TRecord | null> => {
		if (!token.startsWith(this.prefix)) return null;

		const unprefixed = token.slice(this.prefix.length);
		const separatorIndex = unprefixed.indexOf(".");
		if (separatorIndex === -1) return null;

		const selector = unprefixed.slice(0, separatorIndex);
		const validator = unprefixed.slice(separatorIndex + 1);
		if (selector === "" || validator === "") return null;

		const record = await lookup(selector);
		if (!record) return null;

		const validatorHash = await hashValidator(validator);
		let hashMatches: boolean;
		try {
			hashMatches = constantTimeEqual(
				decodeBase64Url(validatorHash),
				decodeBase64Url(record.validatorHash),
			);
		} catch {
			return null;
		}

		return hashMatches ? record : null;
	};
}
