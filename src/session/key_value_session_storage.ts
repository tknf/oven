/**
 * A `SessionStorage` backed by a `KeyValueStore` (injected via the constructor). Only
 * a session id (a 256-bit random hex string returned by `generateSessionId()`) is kept
 * in the cookie; the actual data is stored as a `JSON` string in the `KeyValueStore`.
 *
 * **Important confirmed contract (see the JSDoc in `key_value_store.ts`)**: the
 * `ttlSeconds` passed to `KeyValueStore.set` is always the raw relative TTL. Rounding
 * up TTLs below 60 seconds to 60 seconds is the responsibility of `CloudflareKVStore`
 * (the adapter side); this class never does that.
 *
 * **Sliding TTL**: tracking last-updated time via Cloudflare KV's `getWithMetadata`
 * (a CF-specific API) would pollute the abstraction, so it is not used. Instead, the
 * stored value itself carries a `refreshedAt` (epoch ms), and each `get` re-puts the
 * same data for another `ttlSeconds` whenever the time elapsed since `refreshedAt`
 * exceeds `refreshThresholdMs` (the idea being "don't write on every request"). This
 * re-put (TTL extension) is best-effort and its failure never affects the return
 * value (the authentication result) of `get`.
 *
 * **Interaction with the cookie's own `maxAge` (made explicit rather than left as
 * tribal knowledge)**: when `SessionCookieOptions.maxAge` sets the cookie's own
 * expiry, this sliding TTL (the server-side store's re-put) does **not** extend the
 * cookie's expiry. `Set-Cookie` is only re-sent when `commit` is called (with the
 * automatic commit in `session_accessor.ts`, only while the session `isDirty`), and the
 * TTL extension performed inside `get` merely re-puts the store value without ever
 * returning a Cookie header. This means a cookie with `maxAge` expires on the browser
 * side exactly as scheduled, and from that point the cookie is no longer sent
 * regardless of how fresh the server-side data is. This is not a defect but the
 * intended behavior (if you want the cookie itself to be long-lived, either omit
 * `maxAge` to make it a session cookie, or have the caller explicitly reissue it
 * periodically).
 */
import type { KeyValueStore } from "../kv/key_value_store.js";
import type { SessionData } from "./session.js";
import { isSessionData, Session } from "./session.js";
import type { SessionCookieOptions } from "./session_storage.js";
import { generateSessionId, SessionStorage } from "./session_storage.js";

export type KeyValueSessionStorageOptions = SessionCookieOptions & {
	/** Session expiry in seconds. Defaults to 30 days. */
	ttlSeconds?: number;
	/** Re-put the TTL if this many milliseconds have passed since the last refresh. Defaults to 24 hours. */
	refreshThresholdMs?: number;
};

const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30;
const DEFAULT_REFRESH_THRESHOLD_MS = 1000 * 60 * 60 * 24;

const KEY_PREFIX = "oven_session:";

type StoredRecord = {
	data: SessionData;
	/** The time (epoch ms) the TTL was last refreshed. */
	refreshedAt: number;
};

/**
 * Uses `isSessionData` (the shared guard that excludes arrays; see `session.ts`) to
 * check `data`. Checking only `typeof value.data === "object" && value.data !== null`
 * would also let arrays through, which conflicts with the contract expected by
 * `Session`'s constructor ("a non-array plain object").
 */
const isStoredRecord = (value: unknown): value is StoredRecord =>
	typeof value === "object" &&
	value !== null &&
	"data" in value &&
	"refreshedAt" in value &&
	isSessionData(value.data) &&
	typeof value.refreshedAt === "number";

export class KeyValueSessionStorage extends SessionStorage {
	private readonly ttlSeconds: number;
	private readonly refreshThresholdMs: number;

	constructor(
		private readonly store: KeyValueStore,
		options: KeyValueSessionStorageOptions = {},
	) {
		const { ttlSeconds, refreshThresholdMs, ...cookieOptions } = options;
		super(cookieOptions);
		this.ttlSeconds = ttlSeconds ?? DEFAULT_TTL_SECONDS;
		this.refreshThresholdMs = refreshThresholdMs ?? DEFAULT_REFRESH_THRESHOLD_MS;
	}

	async get(cookieHeader: string | null): Promise<Session> {
		const id = this.readSessionCookie(cookieHeader);
		if (!id) return new Session("");

		const raw = await this.store.get(this.storeKey(id));
		if (!raw) return new Session("");

		const record = KeyValueSessionStorage.parseRecord(raw);
		if (!record) return new Session("");

		await this.refreshIfNeeded(id, record);

		return new Session(id, record.data);
	}

	/**
	 * When `session.needsRegeneration` is set, issues a new id as a defense against
	 * session fixation attacks, deletes the record under the old id, and saves under
	 * the new id (never leaving the old id behind).
	 */
	async commit(session: Session): Promise<string> {
		const oldId = session.id;
		const id = session.needsRegeneration || !oldId ? generateSessionId() : oldId;
		const record: StoredRecord = { data: session.data, refreshedAt: Date.now() };

		if (session.needsRegeneration && oldId) await this.store.delete(this.storeKey(oldId));
		await this.store.set(this.storeKey(id), JSON.stringify(record), this.ttlSeconds);
		session.acknowledgeRegeneration();

		return this.buildCommitCookie(id);
	}

	async destroy(session: Session): Promise<string> {
		if (session.id) await this.store.delete(this.storeKey(session.id));

		return this.buildDestroyCookie();
	}

	private storeKey(id: string): string {
		return `${KEY_PREFIX}${id}`;
	}

	/**
	 * Re-puts (extends) the TTL for the same data only when more than
	 * `refreshThresholdMs` has passed since the last refresh. Failures are swallowed
	 * here (`get` has already succeeded at reading, so a failed extension should not
	 * propagate to the caller).
	 */
	private async refreshIfNeeded(id: string, record: StoredRecord): Promise<void> {
		const needsRefresh = Date.now() - record.refreshedAt > this.refreshThresholdMs;
		if (!needsRefresh) return;

		try {
			const refreshed: StoredRecord = { data: record.data, refreshedAt: Date.now() };
			await this.store.set(this.storeKey(id), JSON.stringify(refreshed), this.ttlSeconds);
		} catch {
			// Swallow TTL-extension failures; reading the authenticated data has already succeeded.
		}
	}

	private static parseRecord(raw: string): StoredRecord | null {
		try {
			const parsed: unknown = JSON.parse(raw);
			return isStoredRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	}
}
