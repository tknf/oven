/**
 * `Storage` implementation backed by the local filesystem, for development
 * use only (use `S3Storage` or similar for production blob storage). Depends
 * on `node:fs`/`node:path`, so it lives under `src/node` and is not
 * referenced by the core (`src/index.ts`). Since the filesystem has no
 * concept of contentType metadata, it is stored in a `<key>.oven-meta.json`
 * sidecar file and read back in `get`.
 */
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Storage, type StorageObject } from "../storage/storage.js";

/** Shape of the metadata stored in the sidecar file. */
type Meta = { contentType: string | null };

/** `Storage` implementation that persists objects as files under a root directory on the local filesystem. */
export class FileStorage extends Storage {
	private readonly root: string;

	constructor(root: string) {
		super();
		this.root = resolve(root);
	}

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		const path = this.resolveKeyPath(key);
		await this.assertRealPathWithinRoot(path);
		await mkdir(dirname(path), { recursive: true });

		if (data instanceof ReadableStream) {
			await pipeline(Readable.fromWeb(data), createWriteStream(path));
		} else if (data instanceof Blob) {
			await writeFile(path, Buffer.from(await data.arrayBuffer()));
		} else {
			await writeFile(path, Buffer.from(data));
		}

		await writeFile(this.metaPath(path), JSON.stringify({ contentType } satisfies Meta));
	}

	async get(key: string): Promise<StorageObject | null> {
		const path = this.resolveKeyPath(key);
		if (!existsSync(path)) return null;

		const contentType = await this.readContentType(path);
		const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
		return { body, contentType };
	}

	async delete(key: string): Promise<void> {
		const path = this.resolveKeyPath(key);
		await this.assertRealPathWithinRoot(path);
		await rm(path, { force: true });
		await rm(this.metaPath(path), { force: true });
	}

	/** Reads back the contentType from the sidecar file. Returns `null` if it does not exist. */
	private async readContentType(path: string): Promise<string | null> {
		const metaPath = this.metaPath(path);
		if (!existsSync(metaPath)) return null;

		const raw = await readFile(metaPath, "utf-8");
		const parsed = JSON.parse(raw) as Meta;
		return parsed.contentType;
	}

	private metaPath(path: string): string {
		return `${path}.oven-meta.json`;
	}

	/** Resolves a key to an absolute path under root. Throws a clear error for keys that point outside root. */
	private resolveKeyPath(key: string): string {
		const resolved = resolve(join(this.root, key));
		if (resolved !== this.root && !resolved.startsWith(this.root + sep)) {
			throw new Error(`FileStorage: key "${key}" points outside the root directory`);
		}
		return resolved;
	}

	/**
	 * `resolveKeyPath` only performs lexical path resolution, so an existing
	 * symlink under root (e.g. `root/foo -> /etc`) could be used to actually
	 * read or write outside root. Here, the deepest existing ancestor
	 * directory of `path` is resolved with `realpath` and verified to be
	 * under root's real path (a minimal safeguard specific to `FileStorage`'s
	 * dev-server use case).
	 */
	private async assertRealPathWithinRoot(path: string): Promise<void> {
		const ancestor = FileStorage.nearestExistingAncestor(dirname(path));
		const [realAncestor, realRoot] = await Promise.all([realpath(ancestor), realpath(this.root)]);

		if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
			throw new Error(
				`FileStorage: the parent directory of key "${path}" points outside the root directory via a symlink`,
			);
		}
	}

	/** Walks up from `path` toward its ancestors and returns the first directory that exists. */
	private static nearestExistingAncestor(path: string): string {
		let current = path;
		while (!existsSync(current)) {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
		return current;
	}
}
