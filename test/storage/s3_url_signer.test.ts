/**
 * Verifies `S3UrlSigner`, which issues S3-compatible SigV4 presigned GET URLs (docs/testing.md L1).
 * Signature computation depends only on Web Crypto (SubtleCrypto) and never triggers fetch, so it runs under Node (vitest).
 */
import { describe, expect, test } from "vite-plus/test";
import type { S3UrlSignerConfig } from "../../src/storage/s3_url_signer.js";
import { S3UrlSigner } from "../../src/storage/s3_url_signer.js";

/** Builds an `S3UrlSignerConfig` for tests. Individual tests only pass the diff via `overrides`. */
const buildSignerConfig = (overrides?: Partial<S3UrlSignerConfig>): S3UrlSignerConfig => ({
	endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
	bucket: "example-media",
	accessKeyId: "dummy-access-key-id",
	secretAccessKey: "dummy-secret-access-key",
	...overrides,
});

describe("S3UrlSigner", () => {
	test("returns a path-style URL with signed query parameters (Expires/Credential/Signature)", async () => {
		const signer = new S3UrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/01ITEM000000000000000000A/0.mp3", 600);
		const url = new URL(signedUrl);

		expect(url.host).toBe("dummy-account-id.r2.cloudflarestorage.com");
		expect(url.pathname).toBe("/example-media/media/01ITEM000000000000000000A/0.mp3");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
		expect(url.searchParams.get("X-Amz-Credential")).toContain("dummy-access-key-id");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
	});

	test("changing expiresInSeconds updates X-Amz-Expires accordingly", async () => {
		const signer = new S3UrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/x/1.mp3", 120);
		const url = new URL(signedUrl);

		expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
	});

	test("an empty key throws", async () => {
		const signer = new S3UrlSigner(buildSignerConfig());

		await expect(signer.presignGet("", 600)).rejects.toThrow();
	});

	test("special characters in the key (space, ?) are path-encoded and don't leak into the query", async () => {
		const signer = new S3UrlSigner(buildSignerConfig());

		const signedUrl = await signer.presignGet("media/a b/1?.mp3", 600);
		const url = new URL(signedUrl);

		expect(url.pathname).toBe("/example-media/media/a%20b/1%3F.mp3");
		expect(url.search).not.toContain("?.mp3");
		expect(url.searchParams.get("X-Amz-Expires")).toBe("600");
	});

	test("a key containing a '..' segment throws (prevents escaping the bucket prefix)", async () => {
		const signer = new S3UrlSigner(buildSignerConfig());

		await expect(signer.presignGet("../secret.txt", 600)).rejects.toThrow(/\.\./);
		await expect(signer.presignGet("media/../../secret.txt", 600)).rejects.toThrow(/\.\./);
	});
});
