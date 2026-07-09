/**
 * Tests the format and correctness of PBKDF2 hash generation/verification (docs/testing.md L1).
 */
import { describe, expect, test } from "vite-plus/test";
import { hashPassword, verifyPassword } from "../../src/auth/password.js";

describe("hashPassword", () => {
	test("starts with the pbkdf2$100000$ format", async () => {
		const hash = await hashPassword("correct-horse-battery-staple");
		expect(hash.startsWith("pbkdf2$100000$")).toBe(true);
	});

	test("produces a different hash each time due to the salt, even for the same password", async () => {
		const [first, second] = await Promise.all([
			hashPassword("correct-horse-battery-staple"),
			hashPassword("correct-horse-battery-staple"),
		]);
		expect(first).not.toBe(second);
	});

	test("specifying iterations produces the pbkdf2$<value>$ format and still verifies", async () => {
		const hash = await hashPassword("correct-horse-battery-staple", { iterations: 250_000 });
		expect(hash.startsWith("pbkdf2$250000$")).toBe(true);
		await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
	});

	test.each([0, -1, 1.5])("throws for an invalid iterations value (%s)", async (iterations) => {
		await expect(hashPassword("correct-horse-battery-staple", { iterations })).rejects.toThrow();
	});
});

describe("verifyPassword", () => {
	test("returns true for the correct password", async () => {
		const hash = await hashPassword("correct-horse-battery-staple");
		await expect(verifyPassword("correct-horse-battery-staple", hash)).resolves.toBe(true);
	});

	test("returns false for an incorrect password", async () => {
		const hash = await hashPassword("correct-horse-battery-staple");
		await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
	});

	test("returns false for a malformed hash with too few segments", async () => {
		await expect(verifyPassword("anything", "pbkdf2$100000$salt-only")).resolves.toBe(false);
	});

	test("returns false for a garbage string", async () => {
		await expect(verifyPassword("anything", "not-a-valid-hash")).resolves.toBe(false);
	});

	test.each(["bcrypt$12$somesalt$somehash", "argon2id$a$b$c"])(
		"returns false for a 4-segment hash from an unknown scheme (%s)",
		async (stored) => {
			await expect(verifyPassword("anything", stored)).resolves.toBe(false);
		},
	);

	test("returns false for a valid-shape pbkdf2 hash with malformed base64 salt/hash", async () => {
		await expect(
			verifyPassword("anything", "pbkdf2$100000$!!!invalid!!!$alsoInvalid!!!"),
		).resolves.toBe(false);
	});

	test("returns false for a non-numeric iteration count", async () => {
		await expect(verifyPassword("anything", "pbkdf2$abc$c2FsdA$aGFzaA")).resolves.toBe(false);
	});

	test("an empty password round-trips through hashPassword/verifyPassword", async () => {
		const hash = await hashPassword("");
		await expect(verifyPassword("", hash)).resolves.toBe(true);
		await expect(verifyPassword("x", hash)).resolves.toBe(false);
	});
});
