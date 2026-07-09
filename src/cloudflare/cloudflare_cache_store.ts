/**
 * Cloudflare Cache API adapter for `KeyValueStore`. Takes a `Cache` instance
 * (obtained from `caches.default` or `caches.open`) via constructor injection and uses it
 * as a key-value store, the same convention `CloudflareKVStore` uses for `KVNamespace` and
 * `R2Storage` uses for `R2Bucket`.
 *
 * Resolving the type of `caches.default` (`@cloudflare/workers-types`) is the responsibility
 * of the app's `tsconfig.json`; oven does not extend global types on its own (no `declare
 * global` pollution, for the same reason `ContextRenderer`'s module augmentation is left to
 * the app).
 *
 * ```ts
 * const store = new CloudflareCacheStore({ cache: caches.default });
 * ```
 *
 * **Important constraint on usage**: the Cache API is a per-data-center cache, unlike KV it
 * is not globally replicated. A value `set` in one colo will simply miss (be treated as
 * `undefined`) when `get` from a different colo. This is within the `KeyValueStore` contract
 * (`get` returning `null` is always a possibility; implementations may be eventually
 * consistent), but this implementation is **only intended for caching**
 * (speculatively storing computed results in `Cache` and recomputing on a miss). Do not
 * inject it into `KeyValueSessionStorage` or `RateLimiter` — crossing colos would make
 * sessions disappear or rate limits silently bypassed (the Cache API has no mechanism to
 * prevent this). Use a globally replicated backend such as `CloudflareKVStore` for sessions
 * and rate limiting.
 */
import { KeyValueStore } from "../kv/key_value_store.js";

/**
 * Default TTL (in seconds) used when `ttlSeconds` is not specified. The Cache API does not
 * guarantee storing a response at all without `Cache-Control`, so `Cache-Control: max-age`
 * must always be set. One year is a conventional upper bound meaning "may effectively stay
 * forever", not an exact expiry time.
 */
const DEFAULT_TTL_SECONDS = 31536000;

export class CloudflareCacheStore extends KeyValueStore {
	private readonly cache: Cache;
	private readonly baseUrl: string;

	constructor(options: { cache: Cache; baseUrl?: string }) {
		super();
		this.cache = options.cache;
		this.baseUrl = options.baseUrl ?? "https://oven-cache.internal/";
	}

	async get(key: string): Promise<string | null> {
		const response = await this.cache.match(this.toUrl(key));
		if (!response) return null;
		return response.text();
	}

	/**
	 * Stores `value` under `key`. Uses `DEFAULT_TTL_SECONDS` when `ttlSeconds` is not
	 * specified (see the class doc comment).
	 */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		const maxAge = ttlSeconds ?? DEFAULT_TTL_SECONDS;
		await this.cache.put(
			this.toUrl(key),
			new Response(value, { headers: { "Cache-Control": `max-age=${maxAge}` } }),
		);
	}

	async delete(key: string): Promise<void> {
		await this.cache.delete(this.toUrl(key));
	}

	/**
	 * Converts a key into a synthetic URL rooted at `baseUrl`, escaping path separators
	 * with `encodeURIComponent`.
	 */
	private toUrl(key: string): string {
		return `${this.baseUrl}${encodeURIComponent(key)}`;
	}
}
