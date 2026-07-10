/**
 * Verifies `S3Storage`, a `Storage` implementation for S3-compatible APIs signed via aws4fetch.
 * Injects a dummy fetch and only checks method/URL/headers/404 behavior (no real S3 traffic).
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { S3Storage } from "../../src/storage/s3_storage.js";

const buildStorage = (fetchImpl: typeof fetch) =>
	new S3Storage({
		endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
		bucket: "dummy-bucket",
		accessKeyId: "dummy-access-key-id",
		secretAccessKey: "dummy-secret-access-key",
		fetch: fetchImpl,
	});

/**
 * Mirrors `S3Storage`'s private `MULTIPART_PART_SIZE_BYTES` (not exported,
 * so duplicated here). Unlike `test/workers/r2_storage.test.ts`, which skips
 * the above-threshold path for cost reasons, `S3Storage`'s fetch is mocked
 * rather than hitting a real backend, so exercising a real >100MiB body is
 * cheap. `LARGE_BODY` is allocated once and reused (read-only, via `.slice`)
 * across the tests below instead of once per test.
 */
const MULTIPART_PART_SIZE_BYTES = 100 * 1024 * 1024;
const LARGE_BODY = new ArrayBuffer(MULTIPART_PART_SIZE_BYTES + 1024);

/**
 * Builds a fetch stub that understands the S3 Multipart Upload request
 * shape (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/
 * `AbortMultipartUpload`), routed by method + query params so each test can
 * focus on the step it's exercising. Returns recorders (`calls`, `partSizes`,
 * `getCompleteBody`) the test asserts against after calling `put`.
 */
const buildMultipartFetch = (
	overrides: { uploadPartResponse?: (partNumber: number) => Response } = {},
) => {
	const uploadId = "upload-123";
	const calls: string[] = [];
	const partSizes: number[] = [];
	let completeBody = "";

	const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
		if (!(input instanceof Request)) throw new Error("expected a Request instance");
		const url = new URL(input.url);

		if (input.method === "POST" && url.searchParams.has("uploads")) {
			calls.push("create");
			return new Response(
				`<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
				{ status: 200 },
			);
		}
		if (input.method === "PUT" && url.searchParams.has("partNumber")) {
			const partNumber = Number(url.searchParams.get("partNumber"));
			expect(url.searchParams.get("uploadId")).toBe(uploadId);
			partSizes.push((await input.arrayBuffer()).byteLength);
			calls.push(`upload-part-${partNumber}`);
			if (overrides.uploadPartResponse) return overrides.uploadPartResponse(partNumber);
			return new Response(null, { status: 200, headers: { ETag: `"etag-${partNumber}"` } });
		}
		if (input.method === "DELETE" && url.searchParams.has("uploadId")) {
			calls.push("abort");
			return new Response(null, { status: 204 });
		}
		if (input.method === "POST" && url.searchParams.has("uploadId")) {
			completeBody = await input.text();
			calls.push("complete");
			return new Response(null, { status: 200 });
		}
		throw new Error(`unexpected multipart request: ${input.method} ${input.url}`);
	});

	return { fetch, calls, partSizes, getCompleteBody: () => completeBody };
};

describe("S3Storage", () => {
	test("put issues a PUT request with a Content-Type header", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request instance");
			expect(input.method).toBe("PUT");
			expect(new URL(input.url).pathname).toBe("/dummy-bucket/media/1.mp3");
			expect(input.headers.get("content-type")).toBe("audio/mpeg");
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.put("media/1.mp3", new TextEncoder().encode("bytes").buffer, "audio/mpeg");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("get normalizes and returns body/contentType on 200", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request instance");
			expect(input.method).toBe("GET");
			return new Response("hello", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});
		const storage = buildStorage(fetch);

		const object = await storage.get("key");

		expect(object?.contentType).toBe("text/plain");
		expect(await new Response(object?.body).text()).toBe("hello");
	});

	test("get returns null on 404", async () => {
		const storage = buildStorage(vi.fn(async () => new Response("not found", { status: 404 })));

		await expect(storage.get("missing")).resolves.toBeNull();
	});

	test("delete issues a DELETE request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request instance");
			expect(input.method).toBe("DELETE");
			return new Response(null, { status: 204 });
		});
		const storage = buildStorage(fetch);

		await storage.delete("key");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("delete treats 404 as success too", async () => {
		const storage = buildStorage(vi.fn(async () => new Response(null, { status: 404 })));

		await expect(storage.delete("missing")).resolves.toBeUndefined();
	});

	test("a non-2xx status such as 500 throws", async () => {
		const storage = buildStorage(vi.fn(async () => new Response("boom", { status: 500 })));

		await expect(storage.get("key")).rejects.toThrow(/boom/);
	});

	test("a key containing '..' makes get/put/delete throw without calling fetch", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
		const storage = buildStorage(fetch);

		await expect(storage.get("../secret.txt")).rejects.toThrow(/\.\./);
		await expect(
			storage.put("media/../../secret.txt", new Blob(["x"]), "text/plain"),
		).rejects.toThrow(/\.\./);
		await expect(storage.delete("..")).rejects.toThrow(/\.\./);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("when maxBytes is set, an oversized put throws before calling fetch", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
		const storage = new S3Storage({
			endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
			bucket: "dummy-bucket",
			accessKeyId: "dummy-access-key-id",
			secretAccessKey: "dummy-secret-access-key",
			fetch,
			maxBytes: 4,
		});

		await expect(
			storage.put("media/1.mp3", new TextEncoder().encode("too big").buffer, "audio/mpeg"),
		).rejects.toThrow(/exceeds the limit/);
		expect(fetch).not.toHaveBeenCalled();
	});

	test("when timeoutMs is set, each get/put/delete fetch call receives an AbortSignal", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(init?.signal).toBeInstanceOf(AbortSignal);
			return new Response("body", { status: 200 });
		});
		const storage = new S3Storage({
			endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
			bucket: "dummy-bucket",
			accessKeyId: "dummy-access-key-id",
			secretAccessKey: "dummy-secret-access-key",
			fetch,
			timeoutMs: 5000,
		});

		await storage.get("key");
		await storage.put("key", new Blob(["x"]), "text/plain");
		await storage.delete("key");

		expect(fetch).toHaveBeenCalledTimes(3);
	});

	test("when timeoutMs is not set, fetch is called without a signal as before", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(init).toBeUndefined();
			return new Response("body", { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.get("key");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("when maxBytes is not set, put works as before without a size check", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
		const storage = buildStorage(fetch);

		await storage.put(
			"media/1.mp3",
			new TextEncoder().encode("this is longer than four bytes").buffer,
			"audio/mpeg",
		);

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("a put exactly at the multipart threshold still issues a single PUT (no multipart)", async () => {
		const data = LARGE_BODY.slice(0, MULTIPART_PART_SIZE_BYTES);
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request instance");
			expect(input.method).toBe("PUT");
			expect(new URL(input.url).searchParams.has("uploadId")).toBe(false);
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.put("media/at-threshold.bin", data, "application/octet-stream");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("a put larger than the multipart threshold performs create -> upload parts -> complete", async () => {
		const { fetch, calls, partSizes, getCompleteBody } = buildMultipartFetch();
		const storage = buildStorage(fetch);

		await storage.put("media/big.bin", LARGE_BODY, "application/octet-stream");

		expect(calls).toEqual(["create", "upload-part-1", "upload-part-2", "complete"]);
		expect(partSizes).toEqual([MULTIPART_PART_SIZE_BYTES, 1024]);
		expect(getCompleteBody()).toBe(
			'<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUpload><Part><PartNumber>1</PartNumber><ETag>"etag-1"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"etag-2"</ETag></Part></CompleteMultipartUpload>',
		);
	});

	test("a failed part upload aborts the multipart upload and rethrows the original error", async () => {
		const { fetch, calls } = buildMultipartFetch({
			uploadPartResponse: () => new Response("boom", { status: 500 }),
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/S3 UploadPart failed/);
		expect(calls).toEqual(["create", "upload-part-1", "abort"]);
	});

	test("a part response missing an ETag header aborts and throws a clear error", async () => {
		const { fetch, calls } = buildMultipartFetch({
			uploadPartResponse: () => new Response(null, { status: 200 }),
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/missing an ETag/);
		expect(calls).toEqual(["create", "upload-part-1", "abort"]);
	});

	test("a create response missing an UploadId throws before any part is uploaded", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request instance");
			return new Response("<InitiateMultipartUploadResult></InitiateMultipartUploadResult>", {
				status: 200,
			});
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/missing an UploadId/);
		expect(fetch).toHaveBeenCalledOnce();
	});

	test("maxBytes rejects an over-threshold body before any multipart request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 200 }));
		const storage = new S3Storage({
			endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
			bucket: "dummy-bucket",
			accessKeyId: "dummy-access-key-id",
			secretAccessKey: "dummy-secret-access-key",
			fetch,
			maxBytes: MULTIPART_PART_SIZE_BYTES,
		});

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/exceeds the limit/);
		expect(fetch).not.toHaveBeenCalled();
	});
});
