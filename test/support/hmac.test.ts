/**
 * Tests `importHmacKey`, the shared HMAC-SHA256 key import helper backing
 * `DataToken`, `CookieSessionStorage`, and `UrlSigner`.
 */
import { describe, expect, test } from "vite-plus/test";
import { HMAC_ALGORITHM, HMAC_KEY_CACHE_MAX, importHmacKey } from "../../src/support/hmac.js";

describe("importHmacKey", () => {
	test("returns the same Promise for the same secret (module-level cache)", () => {
		const first = importHmacKey("shared-secret-value");
		const second = importHmacKey("shared-secret-value");

		expect(first).toBe(second);
	});

	test("returns different Promises for different secrets", () => {
		const first = importHmacKey("secret-a");
		const second = importHmacKey("secret-b");

		expect(first).not.toBe(second);
	});

	test("resolves to a CryptoKey usable for HMAC-SHA256 sign/verify", async () => {
		const key = await importHmacKey("a-sufficiently-long-test-secret");
		const data = new TextEncoder().encode("payload-to-sign");

		const signature = await crypto.subtle.sign(HMAC_ALGORITHM.name, key, data);
		const valid = await crypto.subtle.verify(HMAC_ALGORITHM.name, key, signature, data);

		expect(valid).toBe(true);
	});

	test("two secrets that resolve to different keys produce different signatures for the same data", async () => {
		const [keyA, keyB] = await Promise.all([
			importHmacKey("distinct-secret-a"),
			importHmacKey("distinct-secret-b"),
		]);
		const data = new TextEncoder().encode("payload-to-sign");

		const signatureA = new Uint8Array(await crypto.subtle.sign(HMAC_ALGORITHM.name, keyA, data));
		const signatureB = new Uint8Array(await crypto.subtle.sign(HMAC_ALGORITHM.name, keyB, data));

		expect(signatureA).not.toEqual(signatureB);
	});

	test("the cache is bounded: a cold secret is evicted and re-imported under load, while a repeatedly-used secret's key stays stable", async () => {
		const coldSecret = "hmac-cache-bound-cold-secret";
		const hotSecret = "hmac-cache-bound-hot-secret";

		const coldPromiseBeforeEviction = importHmacKey(coldSecret);
		const hotPromiseBeforeEviction = importHmacKey(hotSecret);

		/*
		 * Push well over HMAC_KEY_CACHE_MAX brand-new secrets through the
		 * cache, re-requesting hotSecret after every insert. Each insert past
		 * the cap evicts only the single least-recently-used entry, so
		 * refreshing hotSecret on every iteration keeps it at the
		 * most-recently-used end and guarantees it is never the one evicted,
		 * while coldSecret (touched once, above, and never again) is
		 * guaranteed to age out well before the loop ends.
		 */
		for (let i = 0; i < HMAC_KEY_CACHE_MAX * 2; i += 1) {
			void importHmacKey(`hmac-cache-bound-filler-secret-${i}`);
			void importHmacKey(hotSecret);
		}

		expect(importHmacKey(hotSecret)).toBe(hotPromiseBeforeEviction);

		const coldPromiseAfterEviction = importHmacKey(coldSecret);
		expect(coldPromiseAfterEviction).not.toBe(coldPromiseBeforeEviction);

		/* Re-importing after eviction is correctness-preserving: the key still works. */
		const key = await coldPromiseAfterEviction;
		const data = new TextEncoder().encode("payload-to-sign");
		const signature = await crypto.subtle.sign(HMAC_ALGORITHM.name, key, data);
		const valid = await crypto.subtle.verify(HMAC_ALGORITHM.name, key, signature, data);
		expect(valid).toBe(true);
	});
});
