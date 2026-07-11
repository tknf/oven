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
 *
 * The cache is bounded to `HMAC_KEY_CACHE_MAX` entries (least-recently-used
 * eviction): all three callers advertise secret rotation as a supported use
 * case (a config reload with a rotated `secrets` list, or a secret derived
 * per tenant), and each distinct secret used to be reclaimed along with the
 * per-instance cache that held it. Now that the cache is module-level and
 * outlives any single instance, an unbounded map would keep every retired
 * secret's `CryptoKey` alive for the life of the process. A secret that falls
 * out of the cache is not lost: `importHmacKey` simply re-imports it on the
 * next call, which is cheap and preserves correctness.
 */

/** The algorithm identifier passed to `crypto.subtle.importKey`/`sign`/`verify`. */
export const HMAC_ALGORITHM = { name: "HMAC", hash: "SHA-256" } as const;

/**
 * Maximum number of distinct secrets kept in `keyCache` at once. Sized well
 * above the number of secrets a single app realistically has in flight at
 * once (current secret plus a few retired ones kept for a rotation grace
 * period), so the common case of one or a handful of static secrets never
 * misses the cache, while a runaway number of distinct secrets still can't
 * grow the cache without bound.
 */
export const HMAC_KEY_CACHE_MAX = 64;

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * Returns the HMAC-SHA256 `CryptoKey` for `secret`, memoized in a
 * module-level cache shared by every caller of this function. The cache is
 * bounded to `HMAC_KEY_CACHE_MAX` entries with least-recently-used eviction
 * (see module doc).
 */
export const importHmacKey = (secret: string): Promise<CryptoKey> => {
	const cached = keyCache.get(secret);
	if (cached) {
		/* Move this entry to the end (most-recently-used) so it survives eviction. */
		keyCache.delete(secret);
		keyCache.set(secret, cached);
		return cached;
	}

	const promise = crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		HMAC_ALGORITHM,
		false,
		["sign", "verify"],
	);
	keyCache.set(secret, promise);

	if (keyCache.size > HMAC_KEY_CACHE_MAX) {
		/* `Map` iterates in insertion order, so the first key is the least recently used. */
		const oldestKey = keyCache.keys().next().value;
		if (oldestKey !== undefined) keyCache.delete(oldestKey);
	}

	return promise;
};
