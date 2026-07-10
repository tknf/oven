/**
 * Tests `importHmacKey`, the shared HMAC-SHA256 key import helper backing
 * `DataToken`, `CookieSessionStorage`, and `UrlSigner`.
 */
import { describe, expect, test } from "vite-plus/test";
import { HMAC_ALGORITHM, importHmacKey } from "../../src/support/hmac.js";

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
});
