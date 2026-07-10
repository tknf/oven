/**
 * Verifies `GcsUrlSigner`, which issues GCS V4 (`GOOG4-RSA-SHA256`) presigned
 * GET URLs signed with a service account's RSA private key.
 * Signature computation depends only on Web Crypto (SubtleCrypto) and never
 * triggers fetch, so it runs under Node (vitest), mirroring
 * `s3_url_signer.test.ts`. A real RSA keypair is generated per test file so
 * the produced `X-Goog-Signature` can be cryptographically verified against
 * an independently reconstructed canonical request, not just shape-checked.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { GcsUrlSignerConfig } from "../../src/storage/gcs_url_signer.js";
import { GcsUrlSigner } from "../../src/storage/gcs_url_signer.js";

const RSA_ALGORITHM = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

/** Base64-encodes an `ArrayBuffer` without relying on Node's `Buffer` (keeps the test runtime-agnostic, like the source under test). */
const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
	let binary = "";
	for (const byte of new Uint8Array(buffer)) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary);
};

/** Wraps a PKCS8 `ArrayBuffer` into a PEM string matching a service account JSON key's `private_key` field shape. */
const toPkcs8Pem = (pkcs8: ArrayBuffer): string => {
	const base64 = arrayBufferToBase64(pkcs8);
	const lines = base64.match(/.{1,64}/g) ?? [base64];
	return ["-----BEGIN PRIVATE KEY-----", ...lines, "-----END PRIVATE KEY-----"].join("\n");
};

const hexToArrayBuffer = (hex: string): ArrayBuffer => {
	const bytes = new Uint8Array(hex.length / 2);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes.buffer;
};

const sha256Hex = async (input: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

/**
 * Parses a `GcsUrlSigner`-produced URL into its raw components (host, path,
 * canonical query string, signature) via string splitting rather than
 * `new URL()`, so the WHATWG URL parser's own normalization never masks a
 * mismatch between what was signed and what appears in the output.
 */
const parseSignedUrl = (
	signedUrl: string,
): { host: string; path: string; canonicalQueryString: string; signatureHex: string } => {
	const match = signedUrl.match(/^https:\/\/([^/]+)(\/[^?]*)\?(.*)&X-Goog-Signature=([0-9a-f]+)$/);
	if (!match) {
		throw new Error(`unexpected signed URL shape: ${signedUrl}`);
	}
	const [, host, path, canonicalQueryString, signatureHex] = match;
	return { host, path, canonicalQueryString, signatureHex };
};

describe("GcsUrlSigner", () => {
	let privateKeyPem: string;
	let publicKey: CryptoKey;

	beforeEach(async () => {
		const { publicKey: generatedPublicKey, privateKey } = await crypto.subtle.generateKey(
			{ ...RSA_ALGORITHM, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
			true,
			["sign", "verify"],
		);
		publicKey = generatedPublicKey;
		privateKeyPem = toPkcs8Pem(await crypto.subtle.exportKey("pkcs8", privateKey));

		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-11T12:34:56.789Z"));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const buildSignerConfig = (overrides?: Partial<GcsUrlSignerConfig>): GcsUrlSignerConfig => ({
		bucket: "example-media",
		clientEmail: "uploader@example-project.iam.gserviceaccount.com",
		privateKeyPem,
		...overrides,
	});

	test("returns a path-style URL with the documented GOOG4-RSA-SHA256 query parameters", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/01ITEM000000000000000000A/0.mp3", 600);
		const { host, path, canonicalQueryString } = parseSignedUrl(signedUrl);
		const params = new URLSearchParams(canonicalQueryString);

		expect(host).toBe("storage.googleapis.com");
		expect(path).toBe("/example-media/media/01ITEM000000000000000000A/0.mp3");
		expect(params.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
		expect(params.get("X-Goog-Credential")).toBe(
			"uploader@example-project.iam.gserviceaccount.com/20260711/auto/storage/goog4_request",
		);
		expect(params.get("X-Goog-Date")).toBe("20260711T123456Z");
		expect(params.get("X-Goog-Expires")).toBe("600");
		expect(params.get("X-Goog-SignedHeaders")).toBe("host");
		expect(signedUrl).toMatch(/&X-Goog-Signature=[0-9a-f]{512}$/);
	});

	test("a custom host is used both in the URL and the signed canonical request", async () => {
		const signer = new GcsUrlSigner(
			buildSignerConfig({ host: "example-media.storage.googleapis.com" }),
		);

		const signedUrl = await signer.presignGet("report.pdf", 300);
		const { host } = parseSignedUrl(signedUrl);

		expect(host).toBe("example-media.storage.googleapis.com");
	});

	test("cryptographically verifies X-Goog-Signature against an independently reconstructed canonical request", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/report.pdf", 300);
		const { host, path, canonicalQueryString, signatureHex } = parseSignedUrl(signedUrl);
		const params = new URLSearchParams(canonicalQueryString);
		const requestTimestamp = params.get("X-Goog-Date");
		const credentialScope = "20260711/auto/storage/goog4_request";
		if (requestTimestamp === null) throw new Error("X-Goog-Date missing from signed URL");

		const canonicalRequest = [
			"GET",
			path,
			canonicalQueryString,
			`host:${host}`,
			"",
			"host",
			"UNSIGNED-PAYLOAD",
		].join("\n");
		const stringToSign = [
			"GOOG4-RSA-SHA256",
			requestTimestamp,
			credentialScope,
			await sha256Hex(canonicalRequest),
		].join("\n");

		const isValid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			publicKey,
			hexToArrayBuffer(signatureHex),
			new TextEncoder().encode(stringToSign),
		);
		expect(isValid).toBe(true);
	});

	test("rejects expiresInSeconds outside GCS's 1..604800 second bounds", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		await expect(signer.presignGet("key", 0)).rejects.toThrow();
		await expect(signer.presignGet("key", 604801)).rejects.toThrow();
	});

	test("accepts the documented boundary values (1 second and 7 days)", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		await expect(signer.presignGet("key", 1)).resolves.toEqual(expect.any(String));
		await expect(signer.presignGet("key", 604800)).resolves.toEqual(expect.any(String));
	});

	test("an empty key throws", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		await expect(signer.presignGet("", 600)).rejects.toThrow();
	});

	test("a key containing a '..' segment throws (prevents escaping the bucket prefix)", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		await expect(signer.presignGet("../secret.txt", 600)).rejects.toThrow(/\.\./);
		await expect(signer.presignGet("media/../../secret.txt", 600)).rejects.toThrow(/\.\./);
	});

	test("special characters in the key (space, ?) are path-encoded and don't leak into the query", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/a b/1?.mp3", 600);
		const { path, canonicalQueryString } = parseSignedUrl(signedUrl);

		expect(path).toBe("/example-media/media/a%20b/1%3F.mp3");
		expect(canonicalQueryString).not.toContain("1?.mp3");
	});

	test("a malformed PEM rejects presignGet with a clear error", async () => {
		const signer = new GcsUrlSigner(buildSignerConfig({ privateKeyPem: "not a pem" }));

		await expect(signer.presignGet("key", 600)).rejects.toThrow(/PEM/);
	});
});
