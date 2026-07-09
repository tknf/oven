/**
 * Tests `DataToken` (a stateless, purpose-scoped token). Verifies the round trip of
 * issuance/verification, automatic invalidation from a fingerprint change, missing
 * target, prevention of cross-purpose reuse, expiration, tampering, malformed format,
 * key rotation, and constructor validation.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { DataToken } from "../../src/auth/data_token.js";
import { encodeBase64Url } from "../../src/support/base64url.js";

describe("DataToken", () => {
	test("verify returns the identity for a generated token when the fingerprint matches", async () => {
		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		const generated = await token.generate("user-1", "fingerprint-a");

		await expect(token.verify(generated, () => "fingerprint-a")).resolves.toBe("user-1");
	});

	test("verify returns null when the fingerprint changes (automatic invalidation after a password change)", async () => {
		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		const generated = await token.generate("user-1", "fingerprint-a");

		await expect(token.verify(generated, () => "fingerprint-b")).resolves.toBeNull();
	});

	test("verify returns null when the resolver returns null (target missing)", async () => {
		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		const generated = await token.generate("user-1", "fingerprint-a");

		await expect(token.verify(generated, () => null)).resolves.toBeNull();
	});

	test("verifying with a DataToken instance of a different purpose returns null (prevents cross-purpose reuse)", async () => {
		const resetToken = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});
		const verifyToken = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:email_verification",
			expiresInSeconds: 600,
		});

		const generated = await resetToken.generate("user-1", "fingerprint-a");

		await expect(verifyToken.verify(generated, () => "fingerprint-a")).resolves.toBeNull();
	});

	test("verify returns null once the token has expired", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));

		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 60,
		});
		const generated = await token.generate("user-1", "fingerprint-a");

		vi.setSystemTime(new Date("2026-07-05T00:00:59.000Z"));
		await expect(token.verify(generated, () => "fingerprint-a")).resolves.toBe("user-1");

		vi.setSystemTime(new Date("2026-07-05T00:01:01.000Z"));
		await expect(token.verify(generated, () => "fingerprint-a")).resolves.toBeNull();

		vi.useRealTimers();
	});

	test("verify still succeeds exactly at the expiry second (the boundary uses strict less-than)", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));

		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 60,
		});
		const generated = await token.generate("user-1", "fingerprint-a");

		// expiresAt === now (60s later): still valid since the check is `expiresAt < now`.
		vi.setSystemTime(new Date("2026-07-05T00:01:00.000Z"));
		await expect(token.verify(generated, () => "fingerprint-a")).resolves.toBe("user-1");

		// expiresAt < now (61s later): expired.
		vi.setSystemTime(new Date("2026-07-05T00:01:01.000Z"));
		await expect(token.verify(generated, () => "fingerprint-a")).resolves.toBeNull();

		vi.useRealTimers();
	});

	test("verify returns null when the token string is tampered with", async () => {
		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});
		const generated = await token.generate("user-1", "fingerprint-a");
		const [payloadB64, signatureB64] = generated.split(".");

		const tamperedPayload = `${payloadB64}x.${signatureB64}`;
		await expect(token.verify(tamperedPayload, () => "fingerprint-a")).resolves.toBeNull();

		/**
		 * Replaces the first character with one guaranteed to differ from the original.
		 * The last character is subject to base64url bit-boundary rules where low bits
		 * are ignored on decode, so a different last character can still decode to the
		 * same byte sequence (not a real tamper); the first character is unaffected by
		 * that and always has all bits significant.
		 */
		const firstChar = signatureB64.startsWith("A") ? "B" : "A";
		const tamperedSignature = `${payloadB64}.${firstChar}${signatureB64.slice(1)}`;
		await expect(token.verify(tamperedSignature, () => "fingerprint-a")).resolves.toBeNull();
	});

	test("verify returns null for a malformed token", async () => {
		const token = new DataToken({
			secrets: ["secret-1"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		await expect(token.verify("no-separator", () => "fingerprint-a")).resolves.toBeNull();
		await expect(token.verify("not-base64!!.signature", () => "fingerprint-a")).resolves.toBeNull();
		await expect(token.verify("bm90LWpzb24.signature", () => "fingerprint-a")).resolves.toBeNull();

		const missingField = encodeBase64Url(
			new TextEncoder().encode(JSON.stringify({ identity: "user-1" })),
		);
		await expect(
			token.verify(`${missingField}.signature`, () => "fingerprint-a"),
		).resolves.toBeNull();
	});

	test("key rotation: an instance holding both new and old secrets can verify a token issued with the old key", async () => {
		const oldToken = new DataToken({
			secrets: ["old-secret"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});
		const generated = await oldToken.generate("user-1", "fingerprint-a");

		const rotatedToken = new DataToken({
			secrets: ["new-secret", "old-secret"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		await expect(rotatedToken.verify(generated, () => "fingerprint-a")).resolves.toBe("user-1");
	});

	test("key rotation: an instance with only the old key cannot verify a token issued with the new key", async () => {
		const newToken = new DataToken({
			secrets: ["new-secret"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});
		const generated = await newToken.generate("user-1", "fingerprint-a");

		const oldOnlyToken = new DataToken({
			secrets: ["old-secret"],
			purpose: "oven:password_reset",
			expiresInSeconds: 600,
		});

		await expect(oldOnlyToken.verify(generated, () => "fingerprint-a")).resolves.toBeNull();
	});

	test("constructor throws when secrets is an empty array", () => {
		expect(
			() => new DataToken({ secrets: [], purpose: "oven:password_reset", expiresInSeconds: 600 }),
		).toThrow();
	});

	test("constructor throws when expiresInSeconds is not a positive integer", () => {
		expect(
			() =>
				new DataToken({
					secrets: ["secret-1"],
					purpose: "oven:password_reset",
					expiresInSeconds: 0,
				}),
		).toThrow();
		expect(
			() =>
				new DataToken({
					secrets: ["secret-1"],
					purpose: "oven:password_reset",
					expiresInSeconds: 1.5,
				}),
		).toThrow();
	});

	test("constructor throws when purpose is an empty string", () => {
		expect(
			() => new DataToken({ secrets: ["secret-1"], purpose: "", expiresInSeconds: 600 }),
		).toThrow();
	});
});
