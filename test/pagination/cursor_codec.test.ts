/**
 * Verifies `encodeCursor`/`decodeCursor` (opaque cursor encoding).
 */
import { describe, expect, test } from "vite-plus/test";
import { decodeCursor, encodeCursor } from "../../src/pagination/cursor_codec.js";

describe("encodeCursor/decodeCursor", () => {
	test("a string cursor round-trips and its type is restored", () => {
		const encoded = encodeCursor("abc-123");
		expect(decodeCursor(encoded)).toBe("abc-123");
	});

	test("a numeric cursor round-trips and its type is restored", () => {
		const encoded = encodeCursor(123456789);
		const decoded = decodeCursor(encoded);
		expect(decoded).toBe(123456789);
		expect(typeof decoded).toBe("number");
	});

	test("a multi-byte string (e.g. Japanese) round-trips", () => {
		const encoded = encodeCursor("日本語カーソル🎉");
		expect(decodeCursor(encoded)).toBe("日本語カーソル🎉");
	});

	test("invalid Base64URL returns null", () => {
		expect(decodeCursor("!!!not-base64!!!")).toBeNull();
	});

	test("content without a tag returns null", () => {
		const encoded = encodeCursor("x");
		const withoutTag = encoded.slice(2);
		expect(decodeCursor(withoutTag)).toBeNull();
	});

	test("returns null when the content under the n: tag cannot be numbered", () => {
		const forged = btoa("n:abc").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		expect(decodeCursor(forged)).toBeNull();
	});
});
