/**
 * Verifies `auth/totp.ts` (RFC 6238 TOTP primitives) against the RFC 6238
 * Appendix B test vectors, plus the drift window, replay-step reporting,
 * and `otpauth://` URL shape this module's callers (e.g. admin accounts'
 * TOTP enrollment) depend on.
 */
import { describe, expect, test } from "vite-plus/test";
import { encodeBase32 } from "../../src/support/base32.js";
import {
	buildOtpauthUrl,
	generateTotpCode,
	generateTotpSecret,
	verifyTotpCode,
} from "../../src/auth/totp.js";

/**
 * RFC 6238 Appendix B's shared secret is the ASCII string
 * "12345678901234567890" (20 bytes, an HMAC-SHA1 secret). The vectors table
 * gives 8-digit codes at each `T` (Unix time in seconds); this module's API
 * takes a Base32-encoded secret, so the ASCII secret is encoded once here.
 */
const RFC_6238_SECRET = encodeBase32(new TextEncoder().encode("12345678901234567890"));

/** [Unix time in seconds, expected 8-digit code] pairs, from RFC 6238 Appendix B. */
const RFC_6238_VECTORS: [unixTimeSeconds: number, code: string][] = [
	[59, "94287082"],
	[1111111109, "07081804"],
	[1111111111, "14050471"],
	[1234567890, "89005924"],
	[2000000000, "69279037"],
	[20000000000, "65353130"],
];

describe("totp", () => {
	describe("RFC 6238 Appendix B test vectors (HMAC-SHA1, 8 digits, 30s period)", () => {
		for (const [unixTimeSeconds, code] of RFC_6238_VECTORS) {
			test(`generateTotpCode produces ${code} at T=${unixTimeSeconds}`, async () => {
				const generated = await generateTotpCode({
					secret: RFC_6238_SECRET,
					timestampMs: unixTimeSeconds * 1000,
					digits: 8,
				});

				expect(generated).toBe(code);
			});

			test(`verifyTotpCode accepts ${code} at T=${unixTimeSeconds} and returns its step`, async () => {
				const step = await verifyTotpCode({
					secret: RFC_6238_SECRET,
					code,
					timestampMs: unixTimeSeconds * 1000,
					digits: 8,
					driftSteps: 0,
				});

				expect(step).toBe(Math.floor(unixTimeSeconds / 30));
			});
		}
	});

	test("generateTotpCode defaults to 6 digits", async () => {
		const code = await generateTotpCode({ secret: RFC_6238_SECRET, timestampMs: 59_000 });

		expect(code).toMatch(/^[0-9]{6}$/);
	});

	describe("drift window", () => {
		const secret = generateTotpSecret();
		/** An arbitrary, fixed instant near the start of a 30s step so previous/next steps land at clean offsets. */
		const baseTimestampMs = 1_700_000_000_000 - (1_700_000_000_000 % 30_000);

		test("accepts the previous step's code and reports its step", async () => {
			const previousCode = await generateTotpCode({
				secret,
				timestampMs: baseTimestampMs - 30_000,
			});

			const step = await verifyTotpCode({
				secret,
				code: previousCode,
				timestampMs: baseTimestampMs,
			});

			expect(step).toBe(Math.floor(baseTimestampMs / 30_000) - 1);
		});

		test("accepts the next step's code and reports its step", async () => {
			const nextCode = await generateTotpCode({ secret, timestampMs: baseTimestampMs + 30_000 });

			const step = await verifyTotpCode({ secret, code: nextCode, timestampMs: baseTimestampMs });

			expect(step).toBe(Math.floor(baseTimestampMs / 30_000) + 1);
		});

		test("rejects a code two steps away, outside the default driftSteps=1 window", async () => {
			const farCode = await generateTotpCode({ secret, timestampMs: baseTimestampMs + 60_000 });

			const step = await verifyTotpCode({ secret, code: farCode, timestampMs: baseTimestampMs });

			expect(step).toBeNull();
		});

		test("driftSteps=0 rejects even the adjacent step", async () => {
			const nextCode = await generateTotpCode({ secret, timestampMs: baseTimestampMs + 30_000 });

			const step = await verifyTotpCode({
				secret,
				code: nextCode,
				timestampMs: baseTimestampMs,
				driftSteps: 0,
			});

			expect(step).toBeNull();
		});
	});

	test("verifyTotpCode returns null for a wrong code", async () => {
		const secret = generateTotpSecret();
		const code = await generateTotpCode({ secret, timestampMs: 1_700_000_000_000 });
		const wrongCode = code === "000000" ? "111111" : "000000";

		const step = await verifyTotpCode({ secret, code: wrongCode, timestampMs: 1_700_000_000_000 });

		expect(step).toBeNull();
	});

	test("verifyTotpCode rejects a structurally invalid code (wrong length) without throwing", async () => {
		const secret = generateTotpSecret();

		expect(
			await verifyTotpCode({ secret, code: "12345", timestampMs: 1_700_000_000_000 }),
		).toBeNull();
	});

	test("verifyTotpCode rejects a structurally invalid code (non-digit characters) without throwing", async () => {
		const secret = generateTotpSecret();

		expect(
			await verifyTotpCode({ secret, code: "12345a", timestampMs: 1_700_000_000_000 }),
		).toBeNull();
	});

	test("generateTotpSecret round-trips through generateTotpCode/verifyTotpCode", async () => {
		const secret = generateTotpSecret();
		const code = await generateTotpCode({ secret, timestampMs: 1_700_000_000_000 });

		const step = await verifyTotpCode({ secret, code, timestampMs: 1_700_000_000_000 });

		expect(step).toBe(Math.floor(1_700_000_000_000 / 30_000));
	});

	test("generateTotpSecret produces an unpadded uppercase Base32 string of the expected length", () => {
		const secret = generateTotpSecret();

		expect(secret).toMatch(/^[A-Z2-7]+$/);
		/** 20 default bytes * 8 bits / 5 bits-per-char = 32 Base32 characters. */
		expect(secret).toHaveLength(32);
	});

	describe("buildOtpauthUrl", () => {
		test("builds a well-formed otpauth:// URL with percent-encoded label parts", () => {
			const url = buildOtpauthUrl({
				secret: "JBSWY3DPEHPK3PXP",
				issuer: "My App",
				accountName: "alice@example.com",
			});

			expect(url.startsWith("otpauth://totp/My%20App:alice%40example.com?")).toBe(true);
			const params = new URL(url).searchParams;
			expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
			expect(params.get("issuer")).toBe("My App");
			expect(params.get("algorithm")).toBe("SHA1");
			expect(params.get("digits")).toBe("6");
			expect(params.get("period")).toBe("30");
		});

		test("renders the algorithm without its hyphen for SHA-256/SHA-512", () => {
			expect(
				new URL(
					buildOtpauthUrl({
						secret: "JBSWY3DPEHPK3PXP",
						issuer: "Issuer",
						accountName: "acct",
						algorithm: "SHA-256",
					}),
				).searchParams.get("algorithm"),
			).toBe("SHA256");
			expect(
				new URL(
					buildOtpauthUrl({
						secret: "JBSWY3DPEHPK3PXP",
						issuer: "Issuer",
						accountName: "acct",
						algorithm: "SHA-512",
					}),
				).searchParams.get("algorithm"),
			).toBe("SHA512");
		});

		test("respects a custom digits/periodSeconds", () => {
			const params = new URL(
				buildOtpauthUrl({
					secret: "JBSWY3DPEHPK3PXP",
					issuer: "Issuer",
					accountName: "acct",
					digits: 8,
					periodSeconds: 60,
				}),
			).searchParams;

			expect(params.get("digits")).toBe("8");
			expect(params.get("period")).toBe("60");
		});
	});
});
