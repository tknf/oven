/**
 * Integration test running `RateLimiter` + `CloudflareKVStore` against real workerd KV
 * (docs/testing.md L3). Focuses on the path that was the root cause of a production 500 —
 * that `consume` -> `set` does not throw when, mid-window, the remaining TTL passed to
 * `KeyValueStore.set` drops below 60 seconds (a regression test for the 60-second clamp in
 * `cloudflare_kv_store.ts`, following the same style as `test/workers/cloudflare_kv_store.test.ts`).
 */
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vite-plus/test";
import { CloudflareKVStore } from "../../src/cloudflare/cloudflare_kv_store.js";
import { RateLimiter } from "../../src/security/rate_limiter.js";

describe("RateLimiter (real KV)", () => {
	test("further consumes are rejected once the limit is reached", async () => {
		const limiter = new RateLimiter(new CloudflareKVStore(env.KV));
		const key = "oven:rate-limiter:limit-reached";

		expect(await limiter.consume(key, 2, 30)).toBe(true);
		expect(await limiter.consume(key, 2, 30)).toBe(true);
		expect(await limiter.consume(key, 2, 30)).toBe(false);
	});

	test("consecutive consumes within the window succeed without throwing even when windowSeconds is under 60 (regression for the production 500)", async () => {
		const limiter = new RateLimiter(new CloudflareKVStore(env.KV));
		const key = "oven:rate-limiter:short-window";

		/**
		 * Setting windowSeconds=5 seconds means the `ttlSeconds` that `consume` passes to
		 * `KeyValueStore.set` (equal to `windowSeconds` itself on the first call, then the
		 * remaining seconds until `resetAt` afterward) is always under 60 seconds. If the
		 * 60-second clamp in `CloudflareKVStore` weren't working, one of these calls would
		 * have hit a KV-side constraint violation and made put throw.
		 */
		for (let i = 0; i < 5; i++) {
			await expect(limiter.consume(key, 10, 5)).resolves.toBe(true);
		}
	});

	test("calling reset immediately clears the counter, allowing consume again", async () => {
		const limiter = new RateLimiter(new CloudflareKVStore(env.KV));
		const key = "oven:rate-limiter:reset";

		expect(await limiter.consume(key, 1, 30)).toBe(true);
		expect(await limiter.consume(key, 1, 30)).toBe(false);

		await limiter.reset(key);

		expect(await limiter.consume(key, 1, 30)).toBe(true);
	});
});
