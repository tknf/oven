/**
 * Verifies `generateSessionId` (session ID generation for KV/DB-backed
 * storage) (docs/testing.md L1).
 */
import { describe, expect, test } from "vite-plus/test";
import { generateSessionId } from "../../src/session/session_storage.js";

describe("generateSessionId", () => {
	test("returns a 64-character lowercase hex string", () => {
		const id = generateSessionId();

		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	test("does not produce duplicates across multiple calls", () => {
		const ids = Array.from({ length: 100 }, () => generateSessionId());

		expect(new Set(ids).size).toBe(ids.length);
	});
});
