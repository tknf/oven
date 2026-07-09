/**
 * Verifies `R2Storage` from `src/r2_storage.ts` against R2's local simulation (miniflare)
 * (docs/testing.md L3). `env.TEST_BUCKET` is materialized by `@cloudflare/vitest-pool-workers`
 * from the binding definition in `wrangler.jsonc`.
 * Switching to Multipart Upload (over 100MiB) is not covered here for test cost reasons; it is
 * only assumed during code review that the implementation uses the API calls documented by
 * Cloudflare (`createMultipartUpload`/`uploadPart`/`complete`).
 */
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vite-plus/test";
import { R2Storage } from "../../src/cloudflare/r2_storage.js";

describe("R2Storage", () => {
	test("put an ArrayBuffer and get it back in normalized form (body/contentType)", async () => {
		const storage = new R2Storage(env.TEST_BUCKET);
		const data = new TextEncoder().encode("array-buffer-bytes").buffer;

		await storage.put("test/array-buffer", data, "application/octet-stream");

		const object = await storage.get("test/array-buffer");
		expect(object).not.toBeNull();
		expect(object?.contentType).toBe("application/octet-stream");
		expect(await new Response(object?.body).text()).toBe("array-buffer-bytes");
	});

	test("put a Blob and recover its Content-Type", async () => {
		const storage = new R2Storage(env.TEST_BUCKET);
		const data = new Blob(["blob-bytes"], { type: "text/plain" });

		await storage.put("test/blob", data, "image/jpeg");

		const object = await storage.get("test/blob");
		expect(object?.contentType).toBe("image/jpeg");
		expect(await new Response(object?.body).text()).toBe("blob-bytes");
	});

	test("put a ReadableStream and retrieve it (below the threshold uses the normal put path)", async () => {
		const storage = new R2Storage(env.TEST_BUCKET);
		const stream = new Blob(["stream-bytes"]).stream();

		await storage.put("test/stream", stream, "text/plain");

		const object = await storage.get("test/stream");
		expect(await new Response(object?.body).text()).toBe("stream-bytes");
	});

	test("get returns null for a key that was never stored", async () => {
		const storage = new R2Storage(env.TEST_BUCKET);
		expect(await storage.get("test/none")).toBeNull();
	});

	test("get returns null after delete removes the entry", async () => {
		const storage = new R2Storage(env.TEST_BUCKET);
		await storage.put("test/delete-me", new ArrayBuffer(0), "text/plain");

		await storage.delete("test/delete-me");

		expect(await storage.get("test/delete-me")).toBeNull();
	});
});
