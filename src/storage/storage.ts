/**
 * Base class that abstracts a file storage backend.
 * It depends on no backend-specific type (e.g. `R2Bucket`). Wrappers with
 * domain-specific key naming or validation should not live here; applications
 * receive this `Storage` via constructor injection (composition) and implement
 * that logic themselves. This class only provides the minimal put/get/delete
 * operations.
 */

/** Return value of `get`. A normalized shape that avoids leaking backend-specific object types (e.g. `R2ObjectBody`). */
export type StorageObject = {
	body: ReadableStream;
	contentType: string | null;
};

export abstract class Storage {
	/** Stores data under a key. Putting to an existing key overwrites it. */
	abstract put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void>;

	/** Retrieves the data for a key. Returns null if it does not exist. */
	abstract get(key: string): Promise<StorageObject | null>;

	/** Deletes the data for a key. */
	abstract delete(key: string): Promise<void>;
}
