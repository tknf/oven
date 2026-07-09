/**
 * `KeyValueStore` implementation backed by `node:fs/promises`, intended for
 * development and single-server deployments. Lives under `src/node` and is not
 * referenced by the core (`src/index.ts`).
 *
 * TTL is only enforced as lazy deletion on `get`. There is no active GC
 * (background scan that removes expired keys), so a key that is written once
 * and never accessed again will remain on disk as a file even after it
 * expires. This is an intentional tradeoff for a use case that does not
 * require the strictness described in `KeyValueStore`'s class doc; lazy
 * deletion is considered sufficient here.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { KeyValueStore } from "../kv/key_value_store.js";

/** Shape of the content written to a file. `expiresAt` is a Unix timestamp in milliseconds, or `null` when no TTL was given. */
type Entry = { value: string; expiresAt: number | null };

/** `KeyValueStore` implementation that persists entries as JSON files on the local filesystem. */
export class FileKeyValueStore extends KeyValueStore {
	private readonly directory: string;

	constructor(options: { directory: string }) {
		super();
		this.directory = resolve(options.directory);
	}

	async get(key: string): Promise<string | null> {
		const path = this.resolveKeyPath(key);

		let raw: string;
		try {
			raw = await readFile(path, "utf-8");
		} catch (error) {
			if (this.isEnoent(error)) return null;
			throw error;
		}

		const entry = JSON.parse(raw) as Entry;
		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			await rm(path, { force: true });
			return null;
		}
		return entry.value;
	}

	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		const path = this.resolveKeyPath(key);
		await mkdir(this.directory, { recursive: true });

		const entry = {
			value,
			expiresAt: ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000,
		} satisfies Entry;
		await writeFile(path, JSON.stringify(entry));
	}

	async delete(key: string): Promise<void> {
		await rm(this.resolveKeyPath(key), { force: true });
	}

	/** Checks whether a Node error is `ENOENT` (file not found). */
	private isEnoent(error: unknown): error is NodeJS.ErrnoException {
		return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
	}

	/**
	 * Resolves a key to a file path under the directory. `encodeURIComponent`
	 * encodes path separators (`/`) and `..` to prevent path traversal outside
	 * the directory.
	 */
	private resolveKeyPath(key: string): string {
		return join(this.directory, `${encodeURIComponent(key)}.json`);
	}
}
