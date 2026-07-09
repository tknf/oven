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
});
