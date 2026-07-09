/**
 * HMAC-SHA256 signed URLs. Used to generate and verify time-limited, one-time links such as
 * email verification and password reset links.
 *
 * `secrets: string[]` supports key rotation: signing always uses the first entry
 * (`secrets[0]`), while verification tries every entry in order (the same convention used by
 * `CookieSessionStorage` and `Encrypter`).
 *
 * **The origin is excluded from what gets signed**: the signed target is only
 * `url.pathname + "?" + url.searchParams.toString()` — it does not include `origin` (scheme +
 * host + port). Behind a reverse proxy, the internal hostname the server receives (e.g.
 * `http://localhost:8787`) often differs from the public hostname shown to users (e.g.
 * `https://example.com`); including origin in the signature would make the origin mismatch
 * between issuance and verification, making verification impossible. Query normalization is
 * kept consistent on both the signing and verification sides by routing through
 * `URLSearchParams#toString()` (comparing raw `search` strings directly could fail to match
 * due to percent-encoding variance, etc.).
 */
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";
import { constantTimeEqual } from "../support/constant_time.js";
import { warnWeakSecrets } from "../support/secret_strength_warning.js";

export type UrlSignerOptions = {
	/**
	 * List of signing keys. At least one is required. Signing uses the first entry;
	 * verification tries every entry. Use high-entropy random values equivalent to 32 bytes.
	 * Do not use low-entropy values such as human-chosen passphrases, which are vulnerable to
	 * brute-force attacks.
	 */
	secrets: string[];
};

export type UrlSignOptions = {
	/** When provided, attaches `expires` (epoch seconds); verification returns `false` once expired. */
	expiresInSeconds?: number;
};

const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;
const SIGNATURE_PARAM = "signature";
const EXPIRES_PARAM = "expires";

const importHmacKey = (secret: string): Promise<CryptoKey> =>
	crypto.subtle.importKey("raw", new TextEncoder().encode(secret), HMAC_ALGORITHM, false, [
		"sign",
		"verify",
	]);

/** The canonicalized string that gets signed. See the module JSDoc for why origin is excluded. */
const canonicalTarget = (url: URL): string => `${url.pathname}?${url.searchParams.toString()}`;

export class UrlSigner {
	private readonly secrets: string[];

	/**
	 * Instance-level memoization of `importHmacKey` results. Since a constructor cannot `await`
	 * async work, key import is deferred to first access and its `Promise` itself is cached
	 * (the same convention used by `keyCache` in `CookieSessionStorage`).
	 */
	private readonly keyCache = new Map<string, Promise<CryptoKey>>();

	constructor(options: UrlSignerOptions) {
		if (options.secrets.length === 0) {
			throw new Error("UrlSigner requires at least one secret in secrets");
		}
		warnWeakSecrets(options.secrets, "UrlSigner");
		this.secrets = options.secrets;
	}

	/** Returns the `CryptoKey` for `secret`, memoizing the result. */
	private importKeyCached(secret: string): Promise<CryptoKey> {
		const cached = this.keyCache.get(secret);
		if (cached) return cached;

		const promise = importHmacKey(secret);
		this.keyCache.set(secret, promise);
		return promise;
	}

	/** Returns the HMAC signature bytes for `canonical` using `secret`. */
	private async computeSignature(canonical: string, secret: string): Promise<Uint8Array> {
		const key = await this.importKeyCached(secret);
		const signature = await crypto.subtle.sign(
			HMAC_ALGORITHM.name,
			key,
			new TextEncoder().encode(canonical),
		);
		return new Uint8Array(signature);
	}

	/**
	 * Returns the full URL string with a `signature` parameter (and optionally `expires`)
	 * attached to `url`. If `url` already has a `signature` parameter, throws rather than
	 * silently ignoring the collision with the application's own parameter. Signing always
	 * uses the first key, `secrets[0]`. An arrow-function class field so it can be passed by
	 * reference.
	 */
	readonly sign = async (url: string | URL, options?: UrlSignOptions): Promise<string> => {
		const target = new URL(url);
		if (target.searchParams.has(SIGNATURE_PARAM)) {
			throw new Error(`URL already contains a ${SIGNATURE_PARAM} parameter`);
		}

		if (options?.expiresInSeconds !== undefined) {
			const expires = Math.floor(Date.now() / 1000) + options.expiresInSeconds;
			target.searchParams.set(EXPIRES_PARAM, String(expires));
		}

		// The constructor rejects `secrets.length === 0`, so the first element always exists.
		const signature = await this.computeSignature(canonicalTarget(target), this.secrets[0]);
		target.searchParams.set(SIGNATURE_PARAM, encodeBase64Url(signature));
		return target.toString();
	};

	/**
	 * Verifies a signed URL. If a `Request` is passed, uses `input.url`. A missing or
	 * malformed `signature`, mismatch against every key, or an expired `expires` all result in
	 * `false` (fail-closed). An arrow-function class field so it can be passed by reference.
	 */
	readonly verify = async (input: string | URL | Request): Promise<boolean> => {
		const urlString = input instanceof Request ? input.url : input.toString();

		let target: URL;
		try {
			target = new URL(urlString);
		} catch {
			return false;
		}

		const signatureBase64 = target.searchParams.get(SIGNATURE_PARAM);
		if (!signatureBase64) return false;
		target.searchParams.delete(SIGNATURE_PARAM);

		let signature: Uint8Array<ArrayBuffer>;
		try {
			signature = decodeBase64Url(signatureBase64);
		} catch {
			return false;
		}

		const canonical = canonicalTarget(target);
		let matched = false;
		for (const secret of this.secrets) {
			const expected = await this.computeSignature(canonical, secret);
			if (constantTimeEqual(signature, expected)) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;

		const expiresRaw = target.searchParams.get(EXPIRES_PARAM);
		if (expiresRaw === null) return true;

		const expires = Number(expiresRaw);
		if (!Number.isInteger(expires)) return false;

		return Math.floor(Date.now() / 1000) <= expires;
	};
}
