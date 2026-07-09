/**
 * A thin cache layer that receives a `KeyValueStore` via injection. Values are
 * JSON-serialized before storage (as with Job payloads, the contract with the
 * caller is that values must be JSON-serializable; this is not enforced by
 * types). `remember` provides the "compute and store if missing, otherwise
 * return the stored value" pattern directly.
 *
 * **Note 1**: `null`/`undefined` themselves cannot be stored as cache values,
 * since they would be indistinguishable from a `get` "miss" (=null). If the
 * `compute` passed to `remember` returns `null`/`undefined`, `put` is skipped
 * and that value is returned as-is (it will be recomputed on the next call).
 *
 * **Note 2**: There is no exclusive control (such as a lock) against cache
 * stampedes (duplicate `compute` execution on concurrent misses) — a
 * `KeyValueStore` is eventually consistent, so a safe distributed lock cannot
 * be built on top of it (see the contract in `key_value_store.ts`). Instead,
 * `remember`'s fourth argument `options` (`RememberStaleOptions`) provides
 * serve-stale via stale-while-revalidate (SWR). Even after the fresh period
 * expires, a stale value is returned for a grace period while recomputation
 * happens in the background, substantially reducing duplicate `compute`
 * execution under concurrency (this is a best-effort mitigation, not full
 * mutual exclusion).
 *
 * **Note 3**: TTL is not a guarantee of precise expiry. See the contract in
 * `key_value_store.ts` (precision varies by implementation; TTL is only a
 * hint for "cleanup of keys no longer needed"). SWR's `freshUntil` follows
 * this contract by storing an absolute timestamp (epoch ms) inside the value
 * itself, allowing accurate freshness checks independent of the store's TTL.
 */
import type { KeyValueStore } from "../kv/key_value_store.js";

export type CacheOptions = {
	/** Key prefix passed to the store. Defaults to `"cache:"`. */
	prefix?: string;
};

/**
 * Options for enabling SWR (stale-while-revalidate) on `remember`.
 * When specified, `ttlSeconds` becomes required (an unlimited cache has no
 * concept of fresh expiry, so combining it with SWR would be contradictory).
 */
export type RememberStaleOptions = {
	/** Grace period (in seconds) during which a stale value may still be returned after fresh expiry. */
	staleWhileRevalidateSeconds: number;
	/**
	 * Mechanism for running background revalidation (e.g. Workers'
	 * `executionCtx.waitUntil`). If omitted, the call that detects staleness
	 * waits for revalidation inline before returning (that call alone pays
	 * the recomputation cost, while concurrent calls receive the stale value
	 * immediately — this is what prevents the stampede).
	 */
	waitUntil?: (promise: Promise<void>) => void;
};

/**
 * The shape stored in the store when SWR is enabled. Rather than the raw
 * value, it wraps it in an envelope carrying `freshUntil` (epoch ms), which
 * allows accurate freshness checks independent of the `KeyValueStore`'s TTL
 * (which is only a cleanup hint).
 */
type StaleEnvelope<T> = {
	value: T;
	/** Fresh until this timestamp (epoch ms); treated as stale afterward. */
	freshUntil: number;
};

/** Upper bound (in seconds) for the grace period extended by a soft claim on a stale hit. */
const MAX_SOFT_CLAIM_GRACE_SECONDS = 30;

/** Bundles cache operations backed by a `KeyValueStore`. */
export class Cache {
	private readonly store: KeyValueStore;
	private readonly prefix: string;

	constructor(store: KeyValueStore, options?: CacheOptions) {
		this.store = store;
		this.prefix = options?.prefix ?? "cache:";
	}

	private key = (key: string): string => `${this.prefix}${key}`;

	/**
	 * Gets the value for `key`. Returns `null` if it does not exist or has
	 * expired. The return value is the result of `JSON.parse` cast to `T`;
	 * this is a type contract with the caller (it is the caller's
	 * responsibility to match the type used with `put`).
	 */
	get = async <T>(key: string): Promise<T | null> => {
		const raw = await this.store.get(this.key(key));
		if (raw === null) return null;
		return JSON.parse(raw) as T;
	};

	/**
	 * Stores `value` under `key`. `value` must be `JSON.stringify`-able.
	 * Throws if `undefined` is passed (the case where `JSON.stringify`
	 * returns `undefined`).
	 */
	put = async <T>(key: string, value: T, ttlSeconds?: number): Promise<void> => {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error(`Cache#put: value for key "${key}" is not JSON-serializable (undefined)`);
		}
		await this.store.set(this.key(key), serialized, ttlSeconds);
	};

	/**
	 * Returns the value for `key` if present, otherwise runs `compute`,
	 * stores the result, and returns it. If `compute` returns
	 * `null`/`undefined`, it is returned as-is without storing (see Note 1;
	 * it will be recomputed on the next call).
	 *
	 * Passing `options` (`RememberStaleOptions`) enables SWR mode (see Note
	 * 2). When enabled, `ttlSeconds` is required (throws if omitted). The
	 * storage format changes to an `{ value, freshUntil }` envelope, so
	 * **do not mix `options` present/absent for the same key** (if a raw
	 * JSON value is read back, it is treated as a miss and overwritten with
	 * the envelope format — once a key switches, it stays in envelope
	 * format thereafter).
	 */
	remember = async <T>(
		key: string,
		ttlSeconds: number | undefined,
		compute: () => T | Promise<T>,
		options?: RememberStaleOptions,
	): Promise<T> => {
		if (options === undefined) {
			const cached = await this.get<T>(key);
			if (cached !== null) return cached;

			const value = await compute();
			if (value === null || value === undefined) return value;

			await this.put(key, value, ttlSeconds);
			return value;
		}

		if (ttlSeconds === undefined) {
			throw new Error(
				"Cache#remember: ttlSeconds is required when the SWR option (options) is specified (unlimited TTL and SWR are contradictory)",
			);
		}

		return this.rememberStale<T>(key, ttlSeconds, compute, options);
	};

	/** Deletes `key`. */
	forget = async (key: string): Promise<void> => {
		await this.store.delete(this.key(key));
	};

	/**
	 * Core implementation of `remember` in SWR mode. If a raw JSON value
	 * (not an envelope) is read, it is treated as a miss and overwritten.
	 * On a stale hit, a "soft claim" first re-puts the same value with
	 * `freshUntil` extended by a short grace period before recomputing,
	 * reducing duplicate `compute` execution from concurrent stale
	 * detection (this is a best-effort mitigation under eventual
	 * consistency; a handful of duplicate recomputations are tolerated).
	 */
	private rememberStale = async <T>(
		key: string,
		ttlSeconds: number,
		compute: () => T | Promise<T>,
		options: RememberStaleOptions,
	): Promise<T> => {
		const storeKey = this.key(key);
		const raw = await this.store.get(storeKey);
		const envelope = raw === null ? null : this.parseStaleEnvelope<T>(raw);

		if (envelope === null) {
			const value = await compute();
			if (value === null || value === undefined) return value;

			await this.putStaleEnvelope(
				storeKey,
				{ value, freshUntil: Date.now() + ttlSeconds * 1000 },
				ttlSeconds,
				options.staleWhileRevalidateSeconds,
			);
			return value;
		}

		if (Date.now() < envelope.freshUntil) {
			return envelope.value;
		}

		// Stale hit: extend a soft claim to temporarily treat subsequent requests
		// as fresh, preventing a rush of recomputation.
		const graceSeconds = Math.min(ttlSeconds, MAX_SOFT_CLAIM_GRACE_SECONDS);
		await this.putStaleEnvelope(
			storeKey,
			{ value: envelope.value, freshUntil: Date.now() + graceSeconds * 1000 },
			ttlSeconds,
			options.staleWhileRevalidateSeconds,
		);

		/**
		 * Revalidates and stores the result. If `compute` returns
		 * `null`/`undefined`, it is not stored and `null` (sentinel) is
		 * returned (the caller falls back to the stale value).
		 */
		const revalidate = async (): Promise<T | null> => {
			const value = await compute();
			if (value === null || value === undefined) return null;

			await this.putStaleEnvelope(
				storeKey,
				{ value, freshUntil: Date.now() + ttlSeconds * 1000 },
				ttlSeconds,
				options.staleWhileRevalidateSeconds,
			);
			return value;
		};

		if (options.waitUntil) {
			// Revalidate in the background. Errors here have no destination to
			// report to, so they are swallowed (retried on the next stale
			// detection). The caller receives the stale value immediately.
			options.waitUntil(
				revalidate()
					.then(() => undefined)
					.catch(() => undefined),
			);
			return envelope.value;
		}

		const revalidated = await revalidate();
		return revalidated === null ? envelope.value : revalidated;
	};

	/** Parses and validates the store's raw value as a `StaleEnvelope<T>`. Returns `null` if malformed. */
	private parseStaleEnvelope = <T>(raw: string): StaleEnvelope<T> | null => {
		try {
			const parsed: unknown = JSON.parse(raw);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				"value" in parsed &&
				"freshUntil" in parsed &&
				typeof parsed.freshUntil === "number"
			) {
				return { value: parsed.value as T, freshUntil: parsed.freshUntil };
			}
			return null;
		} catch {
			return null;
		}
	};

	/**
	 * Stores an envelope under `storeKey`, which is already prefixed.
	 * Since `KeyValueStore`'s TTL is only a hint for "cleanup of keys no
	 * longer needed" (see the contract in `key_value_store.ts`), the sum
	 * of the fresh period and the stale grace period is passed (accurate
	 * freshness judgment is handled via `freshUntil` instead).
	 */
	private putStaleEnvelope = async <T>(
		storeKey: string,
		envelope: StaleEnvelope<T>,
		ttlSeconds: number,
		staleWhileRevalidateSeconds: number,
	): Promise<void> => {
		await this.store.set(
			storeKey,
			JSON.stringify(envelope),
			ttlSeconds + staleWhileRevalidateSeconds,
		);
	};
}
