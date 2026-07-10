/**
 * Verifies `encodeBase32`/`decodeBase32` (`src/support/base32.ts`) against the
 * RFC 4648 §10 test vectors, plus case/padding tolerance and invalid-input
 * handling.
 */
import { describe, expect, test } from "vite-plus/test";
import { decodeBase32, encodeBase32 } from "../../src/support/base32.js";

/** RFC 4648 §10 Base32 test vectors: ASCII input paired with its padded, uppercase Base32 encoding. */
const RFC_4648_VECTORS: [ascii: string, base32: string][] = [
	["", ""],
	["f", "MY======"],
	["fo", "MZXQ===="],
	["foo", "MZXW6==="],
	["foob", "MZXW6YQ="],
	["fooba", "MZXW6YTB"],
	["foobar", "MZXW6YTBOI======"],
];

const asciiToBytes = (ascii: string): Uint8Array => new TextEncoder().encode(ascii);

describe("base32", () => {
	describe("RFC 4648 §10 test vectors", () => {
		for (const [ascii, base32] of RFC_4648_VECTORS) {
			test(`encodeBase32(${JSON.stringify(ascii)}) produces the unpadded form of ${JSON.stringify(base32)}`, () => {
				expect(encodeBase32(asciiToBytes(ascii))).toBe(base32.replace(/=+$/, ""));
			});

			test(`decodeBase32(${JSON.stringify(base32)}) round-trips to ${JSON.stringify(ascii)}`, () => {
				expect(decodeBase32(base32)).toEqual(asciiToBytes(ascii));
			});
		}
	});

	test("decode tolerates lowercase input", () => {
		expect(decodeBase32("mzxw6ytboi======")).toEqual(asciiToBytes("foobar"));
	});

	test("decode tolerates a mix of unpadded and padded input", () => {
		expect(decodeBase32("MZXW6YTB")).toEqual(asciiToBytes("fooba"));
		expect(decodeBase32("MZXW6YQ=")).toEqual(asciiToBytes("foob"));
	});

	test("encode always omits padding", () => {
		for (const [, base32] of RFC_4648_VECTORS) {
			expect(base32.includes("=") ? base32.replace(/=+$/, "") : base32).not.toContain("=");
		}
	});

	test("decode throws TypeError on a character outside the Base32 alphabet", () => {
		expect(() => decodeBase32("!!!invalid!!!")).toThrow(TypeError);
		expect(() => decodeBase32("MZXW6YTB1")).toThrow(TypeError);
	});

	test("random values round-trip", () => {
		const bytes = crypto.getRandomValues(new Uint8Array(20));

		expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
	});
});
