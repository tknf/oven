/**
 * Verifies `GoogleCloudStorage`, a `Storage` implementation backed by the GCS JSON API.
 * Injects a dummy fetch and dummy tokenProvider to check URLs, Authorization headers, and 404 behavior.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { GoogleCloudStorage } from "../../src/storage/google_cloud_storage.js";

const buildStorage = (fetchImpl: typeof fetch) =>
	new GoogleCloudStorage({
		bucket: "dummy-bucket",
		tokenProvider: async () => "dummy-access-token",
		fetch: fetchImpl,
	});

/** Extracts the URL string to assert against from `fetch`'s first argument (`RequestInfo | URL`). */
const toUrlString = (input: RequestInfo | URL): string =>
	input instanceof Request ? input.url : input.toString();

/**
 * Mirrors `GoogleCloudStorage`'s private `RESUMABLE_THRESHOLD_BYTES` (not
 * exported, so duplicated here; same convention as
 * `test/storage/s3_storage.test.ts`'s `MULTIPART_PART_SIZE_BYTES`). `fetch`
 * is mocked, so exercising a real >100MiB body is cheap; `LARGE_BODY` is
 * allocated once and reused (read-only, via `.slice`) across the tests below.
 */
const RESUMABLE_THRESHOLD_BYTES = 100 * 1024 * 1024;
const LARGE_BODY = new ArrayBuffer(RESUMABLE_THRESHOLD_BYTES + 1024);

describe("GoogleCloudStorage", () => {
	test("put POSTs to the uploadType=media URL with an Authorization header", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(toUrlString(input)).toBe(
				"https://storage.googleapis.com/upload/storage/v1/b/dummy-bucket/o?uploadType=media&name=media%2F1.mp3",
			);
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer dummy-access-token");
			expect(headers.get("content-type")).toBe("audio/mpeg");
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.put("media/1.mp3", new TextEncoder().encode("bytes").buffer, "audio/mpeg");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("get requests the alt=media URL and returns body/contentType", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			expect(toUrlString(input)).toBe(
				"https://storage.googleapis.com/storage/v1/b/dummy-bucket/o/key?alt=media",
			);
			return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
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
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(toUrlString(input)).toBe(
				"https://storage.googleapis.com/storage/v1/b/dummy-bucket/o/key",
			);
			expect(init?.method).toBe("DELETE");
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

	test("a Blob at or below the resumable threshold keeps the simple uploadType=media upload", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(toUrlString(input)).toBe(
				"https://storage.googleapis.com/upload/storage/v1/b/dummy-bucket/o?uploadType=media&name=media%2Fsmall.bin",
			);
			expect(init?.method).toBe("POST");
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.put("media/small.bin", new Blob(["small"]), "application/octet-stream");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("a ReadableStream always uses the simple upload path regardless of size", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			expect(toUrlString(input)).toContain("uploadType=media");
			expect(init?.body).toBeInstanceOf(ReadableStream);
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await storage.put("media/stream.bin", new Blob(["stream-bytes"]).stream(), "text/plain");

		expect(fetch).toHaveBeenCalledOnce();
	});

	test("an ArrayBuffer larger than the resumable threshold performs initiate -> chunked PUTs", async () => {
		const sessionUri =
			"https://storage.googleapis.com/upload/storage/v1/b/dummy-bucket/o?upload_id=session-abc";
		const totalSize = RESUMABLE_THRESHOLD_BYTES + 1024;
		const calls: string[] = [];
		const contentRanges: string[] = [];

		const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
			const url = toUrlString(input);
			const headers = new Headers(init?.headers);

			if (url.includes("uploadType=resumable")) {
				calls.push("initiate");
				expect(init?.method).toBe("POST");
				expect(headers.get("authorization")).toBe("Bearer dummy-access-token");
				expect(headers.get("x-upload-content-type")).toBe("application/octet-stream");
				expect(headers.get("x-upload-content-length")).toBe(String(totalSize));
				return new Response(null, { status: 200, headers: { Location: sessionUri } });
			}
			if (url === sessionUri) {
				expect(init?.method).toBe("PUT");
				expect(headers.has("authorization")).toBe(false);
				const contentRange = headers.get("content-range");
				if (contentRange !== null) contentRanges.push(contentRange);
				const isFinal =
					contentRange === `bytes ${RESUMABLE_THRESHOLD_BYTES}-${totalSize - 1}/${totalSize}`;
				calls.push(isFinal ? "chunk-final" : "chunk-intermediate");
				return new Response(null, { status: isFinal ? 200 : 308 });
			}
			throw new Error(`unexpected request: ${url}`);
		});
		const storage = buildStorage(fetch);

		await storage.put("media/big.bin", LARGE_BODY, "application/octet-stream");

		expect(calls).toEqual(["initiate", "chunk-intermediate", "chunk-final"]);
		expect(contentRanges).toEqual([
			`bytes 0-${RESUMABLE_THRESHOLD_BYTES - 1}/${totalSize}`,
			`bytes ${RESUMABLE_THRESHOLD_BYTES}-${totalSize - 1}/${totalSize}`,
		]);
	});

	test("an initiate failure throws before any chunk is uploaded", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			expect(toUrlString(input)).toContain("uploadType=resumable");
			return new Response("boom", { status: 500 });
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/Failed to initiate GCS resumable upload/);
		expect(fetch).toHaveBeenCalledOnce();
	});

	test("an initiate response missing a Location header throws", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			expect(toUrlString(input)).toContain("uploadType=resumable");
			return new Response(null, { status: 200 });
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/missing a Location header/);
	});

	test("a non-308 intermediate chunk response throws", async () => {
		const sessionUri = "https://storage.googleapis.com/session-xyz";
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = toUrlString(input);
			if (url.includes("uploadType=resumable")) {
				return new Response(null, { status: 200, headers: { Location: sessionUri } });
			}
			if (url === sessionUri) return new Response("boom", { status: 500 });
			throw new Error(`unexpected request: ${url}`);
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/GCS resumable upload chunk failed/);
	});

	test("a non-ok final chunk response throws", async () => {
		const sessionUri = "https://storage.googleapis.com/session-final";
		let chunkCount = 0;
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			const url = toUrlString(input);
			if (url.includes("uploadType=resumable")) {
				return new Response(null, { status: 200, headers: { Location: sessionUri } });
			}
			if (url === sessionUri) {
				chunkCount += 1;
				if (chunkCount === 1) return new Response(null, { status: 308 });
				return new Response("boom", { status: 500 });
			}
			throw new Error(`unexpected request: ${url}`);
		});
		const storage = buildStorage(fetch);

		await expect(
			storage.put("media/big.bin", LARGE_BODY, "application/octet-stream"),
		).rejects.toThrow(/GCS resumable upload failed to complete/);
	});
});
