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
import type { MultipartUploader } from "../../src/storage/index.js";

const multipartStorage = (): R2Storage & MultipartUploader => new R2Storage(env.TEST_BUCKET);

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

	test("completes a multipart upload across adapter instances with serializable metadata", async () => {
		const upload = await multipartStorage().createMultipartUpload("test/multipart", "text/plain");
		expect(Object.keys(upload).sort()).toEqual(["key", "uploadId"]);
		const firstBytes = new Uint8Array(5 * 1024 * 1024).fill(65);
		const second = await multipartStorage().uploadPart(
			{ ...upload },
			2,
			new Blob(["tail"]).stream(),
		);
		const first = await multipartStorage().uploadPart({ ...upload }, 1, firstBytes.buffer);
		expect(Object.keys(first).sort()).toEqual(["etag", "partNumber"]);
		expect(await multipartStorage().get(upload.key)).toBeNull();
		await expect(
			multipartStorage().completeMultipartUpload({ ...upload }, [{ ...first }, { ...second }]),
		).resolves.toEqual({ size: firstBytes.byteLength + 4 });
		const object = await multipartStorage().get(upload.key);
		expect(object?.contentType).toBe("text/plain");
		const bytes = new Uint8Array(await new Response(object?.body).arrayBuffer());
		expect(bytes.byteLength).toBe(firstBytes.byteLength + 4);
		expect(bytes.subarray(0, firstBytes.length).every((byte) => byte === 65)).toBe(true);
		expect(new TextDecoder().decode(bytes.subarray(firstBytes.length))).toBe("tail");
		await expect(multipartStorage().uploadPart(upload, 3, new Blob(["late"]))).rejects.toThrow();
	});

	test("failed completion retains the upload for retry with replacement part metadata", async () => {
		const storage = multipartStorage();
		const upload = await storage.createMultipartUpload("test/multipart-retry", "text/plain");
		await storage.put(upload.key, new Blob(["existing"]), "text/plain");
		const old = await storage.uploadPart(upload, 1, new Blob(["old"]));
		const replacement = await multipartStorage().uploadPart(upload, 1, new Blob(["replacement"]));
		await expect(multipartStorage().completeMultipartUpload(upload, [old])).rejects.toThrow();
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("existing");
		await expect(
			multipartStorage().completeMultipartUpload(upload, [replacement]),
		).resolves.toEqual({ size: 11 });
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("replacement");
	});

	test("aborts pending parts without deleting the existing object or another upload", async () => {
		const storage = multipartStorage();
		const upload = await storage.createMultipartUpload("test/multipart-abort", "text/plain");
		await storage.put(upload.key, new Blob(["existing"]), "text/plain");
		const part = await storage.uploadPart(upload, 1, new Blob(["pending"]));
		const other = await storage.createMultipartUpload(upload.key, "text/plain");
		const otherPart = await storage.uploadPart(other, 1, new Blob(["other"]));
		await multipartStorage().abortMultipartUpload({ ...upload });
		await expect(storage.completeMultipartUpload(upload, [part])).rejects.toThrow();
		await expect(storage.uploadPart(upload, 2, new Blob(["late"]))).rejects.toThrow();
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("existing");
		await storage.completeMultipartUpload(other, [otherPart]);
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("other");
	});

	test("invalid references and part numbers propagate backend errors without aborting", async () => {
		const storage = multipartStorage();
		const upload = await storage.createMultipartUpload("test/multipart-invalid", "text/plain");
		for (const invalid of [
			{ ...upload, key: "wrong" },
			{ ...upload, uploadId: "missing" },
		]) {
			await expect(storage.uploadPart(invalid, 1, new Blob(["part"]))).rejects.toThrow();
			await expect(storage.completeMultipartUpload(invalid, [])).rejects.toThrow();
		}
		await expect(storage.uploadPart(upload, 0, new Blob(["part"]))).rejects.toThrow();
		const part = await storage.uploadPart(upload, 1, new Blob(["valid"]));
		await storage.completeMultipartUpload(upload, [part]);
	});
});
