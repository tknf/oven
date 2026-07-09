/**
 * Minimal abstract base for a key-value store. Defines only three operations:
 * `get`/`set` (with TTL)/`delete`.
 *
 * The goal is backend independence. Cloudflare KV is just one of several
 * adapters (`CloudflareKVStore`); swapping it for the dev/test
 * `InMemoryKeyValueStore` requires no change to caller code.
 *
 * Eventual-consistency expectations (important): with some implementations
 * (e.g. CF KV), a `get` immediately after `set` may return a stale value.
 * Do not build logic that requires strong consistency on top of this
 * abstraction. `RateLimiter` is an example designed to tolerate this
 * eventual consistency (fixed windows, allowing some undercounting).
 *
 * TTL handling: `set`'s `ttlSeconds` is meant for "cleaning up keys that are
 * no longer needed", not as a guarantee of an exact expiration time.
 * Precision varies by implementation (e.g. `CloudflareKVStore` rounds up
 * TTLs under 60 seconds to 60 seconds). If exact expiration/validity
 * checking is required, store an absolute timestamp (e.g. `resetAt`) inside
 * the value and let the caller evaluate it.
 */
export abstract class KeyValueStore {
	/** Returns the value for `key`, or `null` if it does not exist or has expired. */
	abstract get(key: string): Promise<string | null>;

	/**
	 * Stores `value` under `key`. When `ttlSeconds` is given, the entry may be
	 * expected to be cleaned up around that many seconds later, but this
	 * should not be treated as an exact expiration guarantee (see class doc).
	 */
	abstract set(key: string, value: string, ttlSeconds?: number): Promise<void>;

	/** Deletes `key`. Does not throw if the key does not exist. */
	abstract delete(key: string): Promise<void>;
}
