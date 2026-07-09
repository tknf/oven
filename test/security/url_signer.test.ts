/**
 * Verifies `UrlSigner` (URL signing with HMAC-SHA256) (docs/testing.md L1).
 * Checks the sign/verify round trip, parameter tampering, a missing
 * signature, expiration, key rotation, throwing on a signature collision,
 * and query notation normalization.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { UrlSigner } from "../../src/security/url_signer.js";

describe("UrlSigner", () => {
	test("verify succeeds for a signed URL", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });

		const signed = await signer.sign("https://example.com/verify?token=abc");

		await expect(signer.verify(signed)).resolves.toBe(true);
	});

	test("verify returns false when a query parameter is tampered with", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify?token=abc");

		const tampered = signed.replace("token=abc", "token=xyz");

		await expect(signer.verify(tampered)).resolves.toBe(false);
	});

	test("verify returns false when there is no signature parameter", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });

		await expect(signer.verify("https://example.com/verify?token=abc")).resolves.toBe(false);
	});

	test("verify returns false after expiresInSeconds has elapsed", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));

		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify", { expiresInSeconds: 60 });

		vi.setSystemTime(new Date("2026-07-05T00:00:59.000Z"));
		await expect(signer.verify(signed)).resolves.toBe(true);

		vi.setSystemTime(new Date("2026-07-05T00:01:01.000Z"));
		await expect(signer.verify(signed)).resolves.toBe(false);

		vi.useRealTimers();
	});

	test("verify returns true exactly at the expires second and false one second later", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-05T00:00:00.000Z"));

		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify", { expiresInSeconds: 60 });

		vi.setSystemTime(new Date("2026-07-05T00:01:00.000Z"));
		await expect(signer.verify(signed)).resolves.toBe(true);

		vi.setSystemTime(new Date("2026-07-05T00:01:01.000Z"));
		await expect(signer.verify(signed)).resolves.toBe(false);

		vi.useRealTimers();
	});

	test("verify returns false when an unsigned query parameter is appended to a signed URL", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify?token=abc");

		const withForgedExpires = `${signed}&expires=9999999999`;
		const withExtraParam = `${signed}&extra=1`;

		await expect(signer.verify(withForgedExpires)).resolves.toBe(false);
		await expect(signer.verify(withExtraParam)).resolves.toBe(false);
	});

	test("verify returns false when the signature parameter is not valid base64url", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });

		await expect(
			signer.verify("https://example.com/verify?token=abc&signature=%21%21%21"),
		).resolves.toBe(false);
	});

	test("key rotation: a URL signed with the old key can still be verified with the new key list", async () => {
		const oldSigner = new UrlSigner({ secrets: ["old-secret"] });
		const signed = await oldSigner.sign("https://example.com/verify?token=abc");

		const rotatedSigner = new UrlSigner({ secrets: ["new-secret", "old-secret"] });

		await expect(rotatedSigner.verify(signed)).resolves.toBe(true);
	});

	test("a signature that matches no key results in false", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify?token=abc");

		const otherSigner = new UrlSigner({ secrets: ["secret-2"] });

		await expect(otherSigner.verify(signed)).resolves.toBe(false);
	});

	test("throws when signing a URL that already contains a signature parameter", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });

		await expect(signer.sign("https://example.com/verify?signature=xxx")).rejects.toThrow();
	});

	test("throws in the constructor when secrets is an empty array", () => {
		expect(() => new UrlSigner({ secrets: [] })).toThrow();
	});

	test("verification succeeds even with a different origin, since it is not part of the signed content", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("http://internal.local:8787/verify?token=abc");

		const publicUrl = signed.replace("http://internal.local:8787", "https://example.com");

		await expect(signer.verify(publicUrl)).resolves.toBe(true);
	});

	test("query notation differences (percent-encoding of spaces) are absorbed by URLSearchParams normalization", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify?name=a+b");

		const reencoded = signed.replace("name=a+b", "name=a%20b");

		await expect(signer.verify(reencoded)).resolves.toBe(true);
	});
});

describe("UrlSigner with Request input", () => {
	test("verifies using input.url when a Request is passed", async () => {
		const signer = new UrlSigner({ secrets: ["secret-1"] });
		const signed = await signer.sign("https://example.com/verify?token=abc");

		const request = new Request(signed);

		await expect(signer.verify(request)).resolves.toBe(true);
	});
});
