/**
 * Cloudflare KV adapter for `KeyValueStore`. Takes a `KVNamespace` (a global type resolved
 * by the host's `wrangler types` output) via constructor injection.
 */
import { KeyValueStore } from "../kv/key_value_store.js";

/** Cloudflare KV constraint: `expiration`/`expirationTtl` cannot be less than 60 seconds in the future. */
const KV_MIN_EXPIRATION_SECONDS = 60;

/** `KeyValueStore` implementation backed by a Cloudflare `KVNamespace`. */
export class CloudflareKVStore extends KeyValueStore {
	constructor(private readonly kv: KVNamespace) {
		super();
	}

	async get(key: string): Promise<string | null> {
		return this.kv.get(key);
	}

	/**
	 * Always passes `ttlSeconds` as a relative TTL (`expirationTtl`); never uses an
	 * absolute time (`expiration`).
	 *
	 * Rationale (root cause of a production 500 error, ported from the original
	 * `src/adapters/rate_limit.ts`): if a caller reads the current time and then awaits
	 * another async operation (e.g. `kv.get`) before calling `kv.put`, the caller's cached
	 * `nowSeconds` can go stale if a second boundary is crossed during the await. Computing
	 * an absolute `expiration` from that stale time and passing it to KV can make the KV
	 * server, judging by its own receipt time, reject the put entirely for being "less than
	 * 60 seconds in the future" (this was the cause of intermittent 500s under production
	 * latency). A relative `expirationTtl` is computed by the KV server from its own put
	 * receipt time, so it always holds regardless of how stale the caller's clock is.
	 *
	 * Because of this history, `KeyValueStore.set` never exposes an API for absolute
	 * expiration (relative TTL only). This adapter additionally rounds up any TTL below
	 * `KV_MIN_EXPIRATION_SECONDS` (60 seconds). Extending the TTL by up to 60 seconds beyond
	 * what the caller requested does not affect correctness, since values that need exact
	 * timing are designed to carry their own absolute time internally (e.g. `RateLimiter`'s
	 * `resetAt`) — see the `KeyValueStore` class doc comment.
	 */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		await this.kv.put(key, value, {
			expirationTtl:
				ttlSeconds === undefined ? undefined : Math.max(KV_MIN_EXPIRATION_SECONDS, ttlSeconds),
		});
	}

	async delete(key: string): Promise<void> {
		await this.kv.delete(key);
	}
}
