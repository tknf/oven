/**
 * Verifies `constantTimeEqual`, a constant-time byte array comparison that mitigates timing attacks.
 */
import { describe, expect, test } from "vite-plus/test";
import { constantTimeEqual } from "../../src/support/constant_time.js";

describe("constantTimeEqual", () => {
	test("byte arrays with the same content are true", () => {
		const a = Uint8Array.from([1, 2, 3]);
		const b = Uint8Array.from([1, 2, 3]);

		expect(constantTimeEqual(a, b)).toBe(true);
	});

	test("byte arrays with different content are false", () => {
		const a = Uint8Array.from([1, 2, 3]);
		const b = Uint8Array.from([1, 2, 4]);

		expect(constantTimeEqual(a, b)).toBe(false);
	});

	test("byte arrays with different lengths are false", () => {
		const a = Uint8Array.from([1, 2, 3]);
		const b = Uint8Array.from([1, 2]);

		expect(constantTimeEqual(a, b)).toBe(false);
	});

	test("two empty arrays are true", () => {
		expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
	});
});
