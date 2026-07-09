/**
 * Fixed-window rate limiting backed by a `KeyValueStore`. Assumes the store may be an
 * eventually-consistent implementation (e.g. Cloudflare KV), so some undercounting can occur
 * under concurrent requests — an accepted tradeoff for use cases like login attempt limiting.
 *
 * Because `get`→`set` is non-atomic, **concurrent** requests against the same key can each
 * read the same count and all pass, allowing the effective count to exceed `limit` (the
 * imprecision doesn't just undercount — it can also let requests through past the limit). An
 * eventually-consistent store widens this window further. For use cases that need strict
 * throughput control, bring your own adapter backed by a store with atomic increments (Durable
 * Objects, Redis INCR, etc.).
 *
 * If `key` is derived from a client IP, do not use client-spoofable headers such as
 * `X-Forwarded-For` directly — use only the real client IP attached by a trusted proxy layer.
 *
 * This does not re-set the TTL on every `set` (put) call as a sliding window would. Doing so
 * would let the count accumulate indefinitely under intermittent failures, effectively
 * extending the window forever. Instead, the `resetAt` (an absolute time) decided on the first
 * `set` is retained as the stored value until the window ends, and only `count` is incremented
 * afterward.
 *
 * Rounding up the TTL (to work around Cloudflare KV's under-60-second constraint) is the
 * responsibility of `CloudflareKVStore`. Window fixedness is enforced by `state.resetAt` (the
 * absolute time stored as a value), not by the store's TTL/expiration, so even if the TTL runs
 * somewhat longer than the actual window, the `state.resetAt <= nowSeconds` check at the top of
 * `consume` still correctly determines a new window (the TTL is merely "cleanup of keys that
 * are no longer needed" — see `cloudflare_kv_store.ts` for details).
 */
import type { KeyValueStore } from "../kv/key_value_store.js";

type RateLimitState = {
	count: number;
	/** UNIX time (seconds) at which the window ends. */
	resetAt: number;
};

/** Manages per-key rate limiting backed by a `KeyValueStore`. */
export class RateLimiter {
	constructor(private readonly store: KeyValueStore) {}

	private static parseState(raw: string | null): RateLimitState | null {
		if (!raw) return null;
		try {
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"count" in parsed &&
				"resetAt" in parsed &&
				typeof parsed.count === "number" &&
				typeof parsed.resetAt === "number"
			) {
				return { count: parsed.count, resetAt: parsed.resetAt };
			}
			return null;
		} catch {
			return null;
		}
	}

	/**
	 * If `key`'s current count is below `limit`, increments it by 1 and returns true.
	 * If it is at or above `limit`, leaves the count unchanged and returns false.
	 * The window is fixed on the first call and resets as a new window on the first call
	 * after `windowSeconds` has elapsed.
	 */
	async consume(key: string, limit: number, windowSeconds: number): Promise<boolean> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const state = RateLimiter.parseState(await this.store.get(key));

		const isFreshWindow = !state || state.resetAt <= nowSeconds;
		const resetAt = isFreshWindow ? nowSeconds + windowSeconds : state.resetAt;
		const count = isFreshWindow ? 0 : state.count;

		if (count >= limit) return false;

		const next: RateLimitState = { count: count + 1, resetAt };
		await this.store.set(key, JSON.stringify(next), resetAt - nowSeconds);
		return true;
	}

	/** Immediately resets the counter, e.g. on successful login (a thin wrapper around the store's delete). */
	async reset(key: string): Promise<void> {
		await this.store.delete(key);
	}
}
