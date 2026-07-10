/**
 * Shared HMAC-SHA256 key import helper.
 *
 * `DataToken`, `CookieSessionStorage`, and `UrlSigner` all sign/verify a
 * canonical string with HMAC-SHA256 given a secret string, and each used to
 * import its own `CryptoKey` per secret independently. Since a class
 * constructor cannot `await` asynchronous work, every one of them deferred
 * the import to first access and memoized the resulting `Promise` in a
 * `Map<string, Promise<CryptoKey>>`. This module extracts exactly that
 * key-import step. The sign/verify calls themselves (and their
 * canonicalization rules) stay in each caller, since those differ per class
 * and forcing them through a shared abstraction would buy little.
 *
 * The cache here is module-level (shared across every caller), keyed by the
 * raw secret string, rather than one cache per class instance. A `CryptoKey`
 * derived from the same secret via HMAC-SHA256 is interchangeable regardless
 * of which class imported it, so sharing the cache avoids redundant
 * `crypto.subtle.importKey` calls when multiple instances (or multiple
 * classes) happen to use the same secret.
 */

/** The algorithm identifier passed to `crypto.subtle.importKey`/`sign`/`verify`. */
export const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Returns the HMAC-SHA256 `CryptoKey` for `secret`, memoized in a
 * module-level cache shared by every caller of this function.
 */
export const importHmacKey = (secret: string): Promise<CryptoKey> => {
	const cached = keyCache.get(secret);
	if (cached) return cached;

	const promise = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		HMAC_ALGORITHM,
		false,
		["sign", "verify"],
	);
	keyCache.set(secret, promise);
	return promise;
};
