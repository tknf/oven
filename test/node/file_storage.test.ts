/**
 * Verifies `FileStorage` (a `Storage` implementation backed by the Node
 * filesystem).
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { FileStorage } from "../../src/node/file_storage.js";

/** Reads a `ReadableStream<Uint8Array>` body fully into a UTF-8 string. */
const readBodyAsText = async (body: ReadableStream): Promise<string> => {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	while (true) {
		const { done, value } = await reader.read();
		if (value) chunks.push(value);
		if (done) break;
	}
	return Buffer.concat(chunks).toString("utf-8");
};

describe("FileStorage", () => {
	let root: string;
	let storage: FileStorage;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "oven-file-storage-"));
		storage = new FileStorage(root);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("put/get round-trip data and contentType", async () => {
		await storage.put(
			"greetings/hello.txt",
			new TextEncoder().encode("hello").buffer,
			"text/plain",
		);

		const object = await storage.get("greetings/hello.txt");
		expect(object).not.toBeNull();
		expect(object?.contentType).toBe("text/plain");
		expect(await readBodyAsText(object?.body as ReadableStream)).toBe("hello");
	});

	test("contentType is null when there is no sidecar file", async () => {
		const path = join(root, "raw.bin");
		await writeFile(path, "dummy");

		const object = await storage.get("raw.bin");
		expect(object?.contentType).toBeNull();
	});

	test("a nonexistent key returns null", async () => {
		expect(await storage.get("does/not/exist.txt")).toBeNull();
	});

	test("delete removes both the body and the sidecar, and does not throw when they don't exist", async () => {
		await storage.put("to-delete.txt", new Blob(["bye"]), "text/plain");
		await storage.delete("to-delete.txt");

		expect(await storage.get("to-delete.txt")).toBeNull();
		expect(existsSync(join(root, "to-delete.txt.oven-meta.json"))).toBe(false);

		await expect(storage.delete("to-delete.txt")).resolves.toBeUndefined();
	});

	test("a key that escapes root (path traversal) throws", async () => {
		await expect(storage.get("../outside.txt")).rejects.toThrow(/outside the root directory/);
		await expect(storage.put("../../outside.txt", new Blob(["x"]), "text/plain")).rejects.toThrow(
			/outside the root directory/,
		);
	});

	test("put with a ReadableStream writes larger data correctly", async () => {
		const size = 1024 * 1024;
		const data = new Uint8Array(size).fill(65);
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				const chunkSize = 64 * 1024;
				for (let offset = 0; offset < size; offset += chunkSize) {
					controller.enqueue(data.slice(offset, Math.min(offset + chunkSize, size)));
				}
				controller.close();
			},
		});

		await storage.put("large.bin", stream, "application/octet-stream");

		const object = await storage.get("large.bin");
		const text = await readBodyAsText(object?.body as ReadableStream);
		expect(text.length).toBe(size);
		expect(text.startsWith("A".repeat(100))).toBe(true);

		const meta = JSON.parse(await readFile(join(root, "large.bin.oven-meta.json"), "utf-8")) as {
			contentType: string | null;
		};
		expect(meta.contentType).toBe("application/octet-stream");
	});

	test("when a symlink inside root points outside root, put through it throws", async () => {
		const outside = await mkdtemp(join(tmpdir(), "oven-file-storage-outside-"));
		await symlink(outside, join(root, "escape"), "dir");

		await expect(storage.put("escape/evil.txt", new Blob(["x"]), "text/plain")).rejects.toThrow(
			/via a symlink/,
		);
		expect(existsSync(join(outside, "evil.txt"))).toBe(false);

		await rm(outside, { recursive: true, force: true });
	});

	test("when a symlink inside root points outside root, delete through it throws", async () => {
		const outside = await mkdtemp(join(tmpdir(), "oven-file-storage-outside-"));
		await writeFile(join(outside, "evil.txt"), "secret");
		await symlink(outside, join(root, "escape"), "dir");

		await expect(storage.delete("escape/evil.txt")).rejects.toThrow(/via a symlink/);
		expect(existsSync(join(outside, "evil.txt"))).toBe(true);

		await rm(outside, { recursive: true, force: true });
	});
});
