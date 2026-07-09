/**
 * Verifies `CloudflareKVStore` in the workerd environment (docs/testing.md L3): a set/get/delete
 * round trip against real KV/miniflare, and that passing a TTL under 60 seconds doesn't make put
 * itself throw and the value can still be read (a regression test for the 60-second clamp).
 */
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vite-plus/test";
import { CloudflareKVStore } from "../../src/cloudflare/cloudflare_kv_store.js";

describe("CloudflareKVStore", () => {
	test("a value set can be retrieved with get, and becomes null after delete", async () => {
		const store = new CloudflareKVStore(env.KV);
		const key = "oven:kv:roundtrip";

		await store.set(key, "value");
		await expect(store.get(key)).resolves.toBe("value");

		await store.delete(key);
		await expect(store.get(key)).resolves.toBeNull();
	});

	test("passing a ttlSeconds under 60 does not make put throw, and the value can be read", async () => {
		const store = new CloudflareKVStore(env.KV);
		const key = "oven:kv:short-ttl";

		await expect(store.set(key, "value", 5)).resolves.toBeUndefined();
		await expect(store.get(key)).resolves.toBe("value");
	});
});
