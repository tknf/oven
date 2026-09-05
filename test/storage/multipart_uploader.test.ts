import { describe, expect, test } from "vite-plus/test";
import { InMemoryStorage, type MultipartUploader } from "../../src/storage/index.js";

const createUpload = async () => {
	const storage = new InMemoryStorage();
	const uploader: MultipartUploader = storage;
	const upload = await uploader.createMultipartUpload("uploads/file", "text/plain");
	return { storage, uploader, upload };
};

describe("InMemoryStorage multipart uploads", () => {
	test("publishes selected parts in order only on completion and retains content type", async () => {
		const { storage, uploader, upload } = await createUpload();
		const third = await uploader.uploadPart(upload, 3, new Blob(["third"]).stream());
		const first = await uploader.uploadPart(upload, 1, new TextEncoder().encode("first").buffer);
		await uploader.uploadPart(upload, 2, new Blob(["omitted"]));
		expect(await storage.get(upload.key)).toBeNull();

		await expect(
			uploader.completeMultipartUpload({ ...upload }, [first, third]),
		).resolves.toBeUndefined();
		const object = await storage.get(upload.key);
		expect(object?.contentType).toBe("text/plain");
		expect(await new Response(object?.body).text()).toBe("firstthird");
		await expect(uploader.uploadPart(upload, 4, new Blob(["late"]))).rejects.toThrow();
		await expect(uploader.completeMultipartUpload(upload, [first, third])).rejects.toThrow();
	});

	test("replacing a part invalidates stale metadata without aborting on failed completion", async () => {
		const { storage, uploader, upload } = await createUpload();
		await storage.put(upload.key, new Blob(["existing"]), "application/json");
		const old = await uploader.uploadPart(upload, 1, new Blob(["old"]));
		const replacement = await uploader.uploadPart(upload, 1, new Blob(["replacement"]));
		await expect(uploader.completeMultipartUpload(upload, [old])).rejects.toThrow();
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("existing");
		await uploader.completeMultipartUpload(upload, [replacement]);
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("replacement");
	});

	test("abort preserves the stored object and does not affect another upload for the key", async () => {
		const { storage, uploader, upload } = await createUpload();
		await storage.put(upload.key, new Blob(["existing"]), "text/plain");
		const other = await uploader.createMultipartUpload(upload.key, "text/plain");
		const part = await uploader.uploadPart(other, 1, new Blob(["other"]));
		await uploader.abortMultipartUpload(upload);
		await uploader.abortMultipartUpload(upload);
		await expect(uploader.uploadPart(upload, 1, new Blob(["late"]))).rejects.toThrow();
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("existing");
		await uploader.completeMultipartUpload(other, [part]);
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("other");
	});

	test("rejects unknown uploads and mismatched keys without damaging the real upload", async () => {
		const { uploader, upload } = await createUpload();
		const part = await uploader.uploadPart(upload, 1, new Blob(["part"]));
		for (const invalid of [
			{ ...upload, key: "wrong" },
			{ ...upload, uploadId: "missing" },
		]) {
			await expect(uploader.uploadPart(invalid, 1, new Blob(["wrong"]))).rejects.toThrow();
			await expect(uploader.completeMultipartUpload(invalid, [part])).rejects.toThrow();
		}
		await expect(uploader.abortMultipartUpload({ ...upload, key: "wrong" })).rejects.toThrow();
		await uploader.completeMultipartUpload(upload, [part]);
	});

	test("rejects invalid part numbers and completion lists while retaining uploaded parts", async () => {
		const { uploader, upload } = await createUpload();
		for (const number of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(uploader.uploadPart(upload, number, new Blob(["part"]))).rejects.toThrow();
		}
		const first = await uploader.uploadPart(upload, 1, new Blob(["first"]));
		const second = await uploader.uploadPart(upload, 2, new Blob(["second"]));
		for (const parts of [[], [first, first], [second, first], [{ ...first, partNumber: 3 }]]) {
			await expect(uploader.completeMultipartUpload(upload, parts)).rejects.toThrow();
		}
		await uploader.completeMultipartUpload(upload, [first, second]);
	});

	test("snapshots uploaded bytes and metadata", async () => {
		const { storage, uploader, upload } = await createUpload();
		const bytes = new TextEncoder().encode("original");
		const part = await uploader.uploadPart(upload, 1, bytes.buffer);
		const metadata = { ...part };
		bytes.fill(0);
		part.etag = "changed";
		await uploader.completeMultipartUpload(upload, [metadata]);
		expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("original");
	});

	test.each(["abort", "complete"] as const)(
		"rejects an in-flight part after %s",
		async (action) => {
			const { storage, uploader, upload } = await createUpload();
			const first = await uploader.uploadPart(upload, 1, new Blob(["first"]));
			let finish = () => {};
			const stream = new ReadableStream<Uint8Array>({
				start: (controller) => {
					finish = () => controller.close();
				},
			});
			const pending = uploader.uploadPart(upload, 2, stream);
			const rejection = expect(pending).rejects.toThrow("Multipart upload not found");
			if (action === "abort") await uploader.abortMultipartUpload(upload);
			else await uploader.completeMultipartUpload(upload, [first]);
			finish();
			await rejection;
			if (action === "abort") expect(await storage.get(upload.key)).toBeNull();
			else expect(await new Response((await storage.get(upload.key))?.body).text()).toBe("first");
		},
	);

	test("a failed body stream leaves the upload available for retry", async () => {
		const { uploader, upload } = await createUpload();
		const failure = new Error("body failed");
		const body = new ReadableStream({ start: (controller) => controller.error(failure) });
		await expect(uploader.uploadPart(upload, 1, body)).rejects.toThrow("body failed");
		const part = await uploader.uploadPart(upload, 1, new Blob(["retry"]));
		await uploader.completeMultipartUpload(upload, [part]);
	});
});
