/**
 * Verifies `FileKeyValueStore` (a `KeyValueStore` implementation backed by
 * the Node filesystem).
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { FileKeyValueStore } from "../../src/node/file_key_value_store.js";

describe("FileKeyValueStore", () => {
	let root: string;
	let store: FileKeyValueStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "oven-file-kv-"));
		store = new FileKeyValueStore({ directory: root });
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	test("a value set can be retrieved with get", async () => {
		await store.set("greeting", "hello");
		expect(await store.get("greeting")).toBe("hello");
	});

	test("a nonexistent key returns null", async () => {
		expect(await store.get("does-not-exist")).toBeNull();
	});

	test("a TTL-expired value returns null and its file is removed", async () => {
		await store.set("short-lived", "value", 1);

		const path = join(root, `${encodeURIComponent("short-lived")}.json`);
		const entry = JSON.parse(await readFile(path, "utf-8")) as {
			value: string;
			expiresAt: number | null;
		};
		await writeFile(path, JSON.stringify({ ...entry, expiresAt: Date.now() - 1000 }));

		expect(await store.get("short-lived")).toBeNull();
		await expect(readFile(path, "utf-8")).rejects.toThrow();
	});

	test("delete removes the key, and does not throw when it doesn't exist", async () => {
		await store.set("to-delete", "value");
		await store.delete("to-delete");

		expect(await store.get("to-delete")).toBeNull();
		await expect(store.delete("to-delete")).resolves.toBeUndefined();
	});

	test("a key containing `../` never escapes the directory and becomes an encodeURIComponent-encoded filename", async () => {
		const key = "../../outside";
		await store.set(key, "value");

		const path = join(root, `${encodeURIComponent(key)}.json`);
		expect(await readFile(path, "utf-8")).toContain("value");
		expect(await store.get(key)).toBe("value");
	});
});
