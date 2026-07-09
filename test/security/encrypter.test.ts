/**
 * Verifies `Encrypter` (reversible encryption using AES-256-GCM)
 * (docs/testing.md L1). Checks the encrypt/decrypt round trip, tamper
 * detection, key mismatch, key rotation, and throwing on empty secrets.
 */
import { describe, expect, test } from "vite-plus/test";
import { Encrypter } from "../../src/security/encrypter.js";

describe("Encrypter", () => {
	test("restores the original plaintext when decrypting an encrypted value", async () => {
		const encrypter = new Encrypter({ secrets: ["secret-1"] });

		const encrypted = await encrypter.encrypt("hello world");
		const decrypted = await encrypter.decrypt(encrypted);

		expect(decrypted).toBe("hello world");
	});

	test("decrypt returns null for tampered ciphertext (does not throw)", async () => {
		const encrypter = new Encrypter({ secrets: ["secret-1"] });
		const encrypted = await encrypter.encrypt("hello world");
		const [iv, ciphertext] = encrypted.split(".");
		const tampered = `${iv}.${ciphertext[0] === "a" ? "b" : "a"}${ciphertext.slice(1)}`;

		const decrypted = await encrypter.decrypt(tampered);

		expect(decrypted).toBeNull();
	});

	test("a value encrypted with a different secret cannot be decrypted and returns null", async () => {
		const encrypter1 = new Encrypter({ secrets: ["secret-1"] });
		const encrypter2 = new Encrypter({ secrets: ["secret-2"] });
		const encrypted = await encrypter1.encrypt("hello world");

		const decrypted = await encrypter2.decrypt(encrypted);

		expect(decrypted).toBeNull();
	});

	test("key rotation: a value encrypted with the old key can still be decrypted with the new key list", async () => {
		const oldEncrypter = new Encrypter({ secrets: ["old-secret"] });
		const encrypted = await oldEncrypter.encrypt("hello world");

		const rotatedEncrypter = new Encrypter({ secrets: ["new-secret", "old-secret"] });
		const decrypted = await rotatedEncrypter.decrypt(encrypted);

		expect(decrypted).toBe("hello world");
	});

	test("decrypt returns null for an empty or 1-byte IV, and for other malformed inputs (does not throw)", async () => {
		const encrypter = new Encrypter({ secrets: ["secret-1"] });
		const encrypted = await encrypter.encrypt("x");
		const [, ciphertext] = encrypted.split(".");

		await expect(encrypter.decrypt(`.${ciphertext}`)).resolves.toBeNull();
		await expect(encrypter.decrypt(`AA.${ciphertext}`)).resolves.toBeNull();
		await expect(encrypter.decrypt("")).resolves.toBeNull();
		await expect(encrypter.decrypt("a.b.c")).resolves.toBeNull();
	});

	test("encrypting and decrypting an empty string round-trips to an empty string", async () => {
		const encrypter = new Encrypter({ secrets: ["secret-1"] });

		const encrypted = await encrypter.encrypt("");
		const decrypted = await encrypter.decrypt(encrypted);

		expect(decrypted).toBe("");
	});

	test("decrypt returns null for a malformed value (no separator)", async () => {
		const encrypter = new Encrypter({ secrets: ["secret-1"] });

		const decrypted = await encrypter.decrypt("not-a-valid-value");

		expect(decrypted).toBeNull();
	});

	test("throws in the constructor when secrets is an empty array", () => {
		expect(() => new Encrypter({ secrets: [] })).toThrow();
	});
});
