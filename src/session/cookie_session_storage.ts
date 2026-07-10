/**
 * A signed-cookie `SessionStorage`. Stores session data directly in the cookie value
 * (no server-side storage needed — the idea that "the cookie itself is the trusted
 * source of information").
 *
 * Signing uses HMAC-SHA256 (Web Crypto, so it does not depend on Node's `crypto`
 * module and runs as-is on Cloudflare Workers). `secrets: string[]` supports key
 * rotation: signing always uses the first key (`secrets[0]`), while verification
 * tries every key in order. This means that right after rotating keys, sessions for
 * users whose cookie was signed with an older key are not invalidated.
 *
 * Tampered values, signature mismatches, or JSON that fails to parse are treated as an
 * **empty session** rather than throwing (per the `SessionStorage.get` contract).
 *
 * `Session.id` is always an empty string. The cookie itself is the data, so there is
 * no indirection of "look up an ID to fetch data from somewhere".
 *
 * **Important constraints (made explicit rather than left as tribal knowledge)**:
 * - Signing prevents tampering and impersonation but is **not encryption**. The
 *   session data (`session.data`) is only Base64URL-encoded and can be read as
 *   plaintext by anyone with access to the browser, a proxy, or DevTools. Do not put
 *   secrets such as passwords or tokens into a session using this backend (if secret
 *   values are needed, use `KeyValueSessionStorage` / `SQLiteDatabaseSessionStorage` /
 *   `PgDatabaseSessionStorage` and keep only the id in the cookie). The **one
 *   intentional exception** is the CSRF secret (the value `csrf.ts` stores in the
 *   session under `SESSION_SECRET_KEY`); see the module JSDoc in `csrf.ts` for why this
 *   exception is allowed.
 * - The entire payload must fit in a single cookie value, so data exceeding the
 *   browser's cookie size limit (typically around 4KB per entry) cannot be stored. If
 *   it is exceeded, the `Set-Cookie` is ignored or truncated by the browser, and the
 *   next `get` fails to restore it (falling back to an empty session). For use cases
 *   that might accumulate large amounts of session data, choose
 *   `KeyValueSessionStorage` / `SQLiteDatabaseSessionStorage` /
 *   `PgDatabaseSessionStorage` instead.
 */
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import { HMAC_ALGORITHM, importHmacKey } from "../support/hmac.js";
import { warnWeakSecrets } from "../support/secret_strength_warning.js";
import type { SessionData } from "./session.js";
import { isSessionData, Session } from "./session.js";
import type { SessionCookieOptions } from "./session_storage.js";
import { SessionStorage } from "./session_storage.js";

export type CookieSessionStorageOptions = SessionCookieOptions & {
	/**
	 * List of signing secrets. At least one is required. Signing always uses the
	 * first entry; verification tries every entry. Use high-entropy random values
	 * equivalent to 32 bytes — low-entropy values such as human-chosen passphrases
	 * are vulnerable to brute-force and must not be used.
	 */
	secrets: string[];
};

export class CookieSessionStorage extends SessionStorage {
	private readonly secrets: string[];

	constructor(options: CookieSessionStorageOptions) {
		const { secrets, ...cookieOptions } = options;
		super(cookieOptions);

		if (secrets.length === 0) {
			throw new Error("CookieSessionStorage requires at least one secret");
		}
		warnWeakSecrets(secrets, "CookieSessionStorage");
		this.secrets = secrets;
	}

	async get(cookieHeader: string | null): Promise<Session> {
		const raw = this.readSessionCookie(cookieHeader);
		if (!raw) return new Session("");

		const data = await this.verify(raw);
		return new Session("", data ?? {});
	}

	/**
	 * Ignores `session.needsRegeneration`: there is no server-side notion of an ID
	 * (the cookie itself is the payload), so there is nothing to rotate. `regenerate()`
	 * still marks the session dirty, so calling it naturally results in a freshly
	 * signed payload being reissued.
	 */
	async commit(session: Session): Promise<string> {
		const value = await this.sign(session.data);
		return this.buildCommitCookie(value);
	}

	/**
	 * There is no server-side notion of an id for this backend (the cookie itself is
	 * the payload), so destroying it is just marking `session` destroyed and returning
	 * an empty value plus a `Max-Age=0` cookie. Marking `session` destroyed (see
	 * `Session.markDestroyed`) still matters here: it keeps `SessionAccessor` from
	 * re-committing the same instance after `destroy` if it was also mutated earlier in
	 * the same request.
	 */
	async destroy(session: Session): Promise<string> {
		session.markDestroyed();
		return this.buildDestroyCookie();
	}

	/** Builds the cookie value as `payload.<base64url signature>`, always signing with the first key. */
	private async sign(data: SessionData): Promise<string> {
		const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(data)));
		// The constructor rejects `secrets.length === 0`, so the first element always exists.
		const key = await importHmacKey(this.secrets[0]);
		const signature = await crypto.subtle.sign(
			HMAC_ALGORITHM.name,
			key,
			new TextEncoder().encode(payload),
		);
		return `${payload}.${encodeBase64Url(new Uint8Array(signature))}`;
	}

	/**
	 * Verifies a cookie value and extracts the payload. Tries each entry in `secrets`
	 * in order and returns the payload for the first one whose signature matches.
	 * Returns `null` on malformed input, no matching key, or corrupted JSON.
	 */
	private async verify(value: string): Promise<SessionData | null> {
		const separatorIndex = value.lastIndexOf(".");
		if (separatorIndex === -1) return null;

		const payload = value.slice(0, separatorIndex);
		const signatureBase64 = value.slice(separatorIndex + 1);
		const payloadBytes = new TextEncoder().encode(payload);

		let signature: Uint8Array<ArrayBuffer>;
		try {
			signature = decodeBase64Url(signatureBase64);
		} catch {
			return null;
		}

		for (const secret of this.secrets) {
			const key = await importHmacKey(secret);
			const valid = await crypto.subtle.verify(HMAC_ALGORITHM.name, key, signature, payloadBytes);
			if (!valid) continue;

			try {
				const parsed: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload)));
				return isSessionData(parsed) ? parsed : null;
			} catch {
				return null;
			}
		}

		return null;
	}
}
