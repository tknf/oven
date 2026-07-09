/**
 * Verifies `encodeBase64Url`/`decodeBase64Url`, the shared Base64URL encode/decode helpers.
 */
import { describe, expect, test } from "vite-plus/test";
import { decodeBase64Url, encodeBase64Url } from "../../src/support/base64url.js";

describe("base64url", () => {
	test("an empty byte array round-trips", () => {
		const bytes = new Uint8Array(0);

		expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
	});

	test("1-3 byte boundaries (lengths where padding presence differs) round-trip", () => {
		for (let length = 1; length <= 3; length++) {
			const bytes = Uint8Array.from({ length }, (_, index) => index + 1);

			expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
		}
	});

	test("random values round-trip", () => {
		const bytes = crypto.getRandomValues(new Uint8Array(32));

		expect(decodeBase64Url(encodeBase64Url(bytes))).toEqual(bytes);
	});

	test("the encoded result contains only URL-safe characters and no padding '='", () => {
		// Deliberately use a byte sequence prone to containing `+`/`/`/`=` (equivalent to 0xfb 0xff 0xfe)
		const bytes = Uint8Array.from([0xfb, 0xff, 0xfe]);

		const encoded = encodeBase64Url(bytes);

		expect(encoded).not.toContain("+");
		expect(encoded).not.toContain("/");
		expect(encoded).not.toContain("=");
		expect(encoded).toMatch(/^[A-Za-z0-9\-_]+$/);
	});

	test("an invalid base64url string throws on decode", () => {
		expect(() => decodeBase64Url("!!!invalid!!!")).toThrow();
	});
});
