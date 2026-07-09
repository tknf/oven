/**
 * `Storage` implementation for development and testing. It only holds values
 * in-process on a `Map` and does not persist them.
 *
 * The `Blob`/`ReadableStream`/`ArrayBuffer` passed to `put` is normalized and
 * held as a `Uint8Array`, and `get` creates and returns a new `ReadableStream`
 * each time (so the same content can be read multiple times).
 */
import { Storage, type StorageObject } from "./storage.js";

type Entry = {
	bytes: Uint8Array;
	contentType: string;
};

/** In-memory `Storage` backend intended for development and testing only. */
export class InMemoryStorage extends Storage {
	private readonly store = new Map<string, Entry>();

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		this.store.set(key, { bytes: await InMemoryStorage.toBytes(data), contentType });
	}

	async get(key: string): Promise<StorageObject | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		const bytes = entry.bytes;
		return {
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			contentType: entry.contentType,
		};
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	private static async toBytes(data: Blob | ReadableStream | ArrayBuffer): Promise<Uint8Array> {
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (data instanceof ReadableStream)
			return new Uint8Array(await new Response(data).arrayBuffer());
		return new Uint8Array(await data.arrayBuffer());
	}
}
