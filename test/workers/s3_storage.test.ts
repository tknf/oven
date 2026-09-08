/** Verifies S3 stream consumption against the Workers runtime without remote S3 requests. */
import { describe, expect, test, vi } from "vite-plus/test";
import { S3Storage } from "../../src/storage/s3_storage.js";

const buildStorage = (fetchImpl: typeof fetch, maxBytes?: number) =>
	new S3Storage({
		endpoint: "https://dummy-account-id.r2.cloudflarestorage.com",
		bucket: "dummy-bucket",
		accessKeyId: "dummy-access-key-id",
		secretAccessKey: "dummy-secret-access-key",
		fetch: fetchImpl,
		maxBytes,
	});

describe("S3Storage streams in Workers", () => {
	test("rejects and cancels an oversized stream before fetching", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const cancel = vi.fn();
		let reads = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				reads += 1;
				controller.enqueue(new Uint8Array(3));
				if (reads === 100) controller.close();
			},
			cancel,
		});
		await expect(buildStorage(fetch, 4).put("key", stream, "text/plain")).rejects.toThrow(
			"Upload size exceeds the limit (4 bytes)",
		);
		expect(reads).toBeLessThanOrEqual(3);
		expect(cancel).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});

	test.each([4, undefined])("uploads the complete stream with maxBytes %s", async (maxBytes) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
			if (!(input instanceof Request)) throw new Error("expected a Request");
			expect(await input.text()).toBe("body");
			return new Response(null, { status: 200 });
		});
		await buildStorage(fetch, maxBytes).put("key", new Blob(["body"]).stream(), "text/plain");
		expect(fetch).toHaveBeenCalledOnce();
	});
});
