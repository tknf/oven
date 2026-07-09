/**
 * `KeyValueStore` implementation for development and testing. Holds values
 * in-process in a `Map`; nothing is persisted.
 *
 * TTL is stored alongside the value as `expiresAt` (an absolute UNIX
 * millisecond timestamp). If an entry has expired by the time `get` is
 * called, it is deleted and `null` is returned (lazy cleanup).
 */
import { KeyValueStore } from "./key_value_store.js";

type Entry = {
	value: string;
	expiresAt: number | null;
};

/** In-memory `KeyValueStore` backed by a `Map`, intended for dev/test use only. */
export class InMemoryKeyValueStore extends KeyValueStore {
	private readonly store = new Map<string, Entry>();

	/** Returns the value for `key`, or `null` if missing or expired (see class doc). */
	async get(key: string): Promise<string | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
			this.store.delete(key);
			return null;
		}

		return entry.value;
	}

	/** Stores `value` under `key`, optionally with a TTL in seconds. */
	async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
		const expiresAt = ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000;
		this.store.set(key, { value, expiresAt });
	}

	/** Deletes `key`. Does not throw if the key does not exist. */
	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}
}
