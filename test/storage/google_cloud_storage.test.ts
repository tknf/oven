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
});
