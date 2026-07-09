/**
 * Verifies `InMemoryStorage` (a `Storage` implementation for development/testing):
 * put/get round-trip, overwrite, delete, and ReadableStream put.
 */
import { describe, expect, test } from "vite-plus/test";
import { InMemoryStorage } from "../../src/storage/in_memory_storage.js";

describe("InMemoryStorage", () => {
	test("get can retrieve an ArrayBuffer that was put", async () => {
		const storage = new InMemoryStorage();

		await storage.put("key", new TextEncoder().encode("bytes").buffer, "application/octet-stream");

		const object = await storage.get("key");
		expect(object?.contentType).toBe("application/octet-stream");
		expect(await new Response(object?.body).text()).toBe("bytes");
	});

	test("get can retrieve a Blob that was put", async () => {
		const storage = new InMemoryStorage();

		await storage.put("key", new Blob(["blob-bytes"]), "text/plain");

		const object = await storage.get("key");
		expect(await new Response(object?.body).text()).toBe("blob-bytes");
	});

	test("get can retrieve a ReadableStream that was put", async () => {
		const storage = new InMemoryStorage();
		const stream = new Blob(["stream-bytes"]).stream();

		await storage.put("key", stream, "text/plain");

		const object = await storage.get("key");
		expect(await new Response(object?.body).text()).toBe("stream-bytes");
	});

	test("a nonexistent key returns null", async () => {
		const storage = new InMemoryStorage();

		await expect(storage.get("missing")).resolves.toBeNull();
	});

	test("put to the same key overwrites the value", async () => {
		const storage = new InMemoryStorage();

		await storage.put("key", new TextEncoder().encode("first").buffer, "text/plain");
		await storage.put("key", new TextEncoder().encode("second").buffer, "text/plain");

		const object = await storage.get("key");
		expect(await new Response(object?.body).text()).toBe("second");
	});

	test("a deleted key returns null from get", async () => {
		const storage = new InMemoryStorage();
		await storage.put("key", new TextEncoder().encode("bytes").buffer, "text/plain");

		await storage.delete("key");

		await expect(storage.get("key")).resolves.toBeNull();
	});

	test("get returns a new ReadableStream each call, allowing multiple reads", async () => {
		const storage = new InMemoryStorage();
		await storage.put("key", new TextEncoder().encode("bytes").buffer, "text/plain");

		const first = await storage.get("key");
		const second = await storage.get("key");

		expect(await new Response(first?.body).text()).toBe("bytes");
		expect(await new Response(second?.body).text()).toBe("bytes");
	});
});
