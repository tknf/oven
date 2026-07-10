/**
 * The session data object. Does not itself handle persistence (that is
 * `SessionStorage`'s responsibility). Represents the "current request's session
 * state" passed between `get`/`commit`/`destroy`.
 *
 * Semantics:
 * - `get`/`set`/`has`/`unset` behave like an ordinary key-value store
 * - A value pushed with `flash(key, value)` disappears the moment it is `get(key)`'d
 *   anywhere (consume-once — if it is never `get`'d after being pushed, it remains for
 *   as long as the session itself is alive)
 *
 * `isDirty` (change tracking): relying on callers to explicitly call `commit` every
 * time would make forgetting to save a caller bug, so this tracking exists to let
 * `session_accessor.ts` offer "auto-commit if dirty", structurally eliminating
 * forgotten saves at the framework level. The session becomes dirty on calls to
 * `set`/`unset`/`flash`, and also when a flash value is consumed via `get` (consuming
 * it changes the data carried into the next request).
 *
 * `isDestroyed` (destruction tracking): a `SessionStorage.destroy` call marks the
 * instance as destroyed regardless of `isDirty`, so that "destroy always wins" even
 * when the same session was also mutated (e.g. via `flash`) earlier in the same
 * request. See `markDestroyed`'s JSDoc for details.
 */
export type SessionData = Record<string, unknown>;

/**
 * Determines whether `value` can be treated as `SessionData` (a non-array plain
 * object). Used as the shared guard by `CookieSessionStorage`,
 * `SQLiteDatabaseSessionStorage`, and `PgDatabaseSessionStorage` to check whether JSON
 * read back from an external source (a cookie value or a DB row) can be trusted as
 * `SessionData`.
 */
export const isSessionData = (value: unknown): value is SessionData =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Reserved key name so flash values can coexist with regular data in the same Map. */
const flashKey = (key: string): string => `__flash_${key}__`;

export class Session {
	private readonly map: Map<string, unknown>;
	private dirty = false;
	private regenerationRequested = false;
	private destroyed = false;

	/**
	 * The session id. Always an empty string for `CookieSessionStorage`, which packs
	 * the entire data into the cookie itself (it does not use the notion of an id).
	 * For KV/DB backends, a brand-new session that has never been `commit`'d yet is an
	 * empty string, and an id is assigned at commit time.
	 */
	readonly id: string;

	constructor(id: string, data: SessionData = {}) {
		this.id = id;
		this.map = new Map(Object.entries(data));
	}

	/** Returns all held data as a flat object (including unconsumed flash values). */
	get data(): Readonly<SessionData> {
		return Object.fromEntries(this.map);
	}

	/** `true` after a call to `set`/`unset`/`flash`, or after a flash value is consumed. */
	get isDirty(): boolean {
		return this.dirty;
	}

	/** `true` after `markDestroyed()` has been called (i.e. `SessionStorage.destroy` has run for this instance). */
	get isDestroyed(): boolean {
		return this.destroyed;
	}

	/** Whether `key` exists as either regular data or an unconsumed flash value. */
	has(key: string): boolean {
		return this.map.has(key) || this.map.has(flashKey(key));
	}

	/**
	 * Returns the value for `key`. Regular data takes precedence; if absent, looks
	 * for an unconsumed flash value. If a flash value is found, it is consumed by
	 * this call (removed from the Map) and marks the session dirty. Returns
	 * `undefined` if neither is present.
	 */
	get(key: string): unknown {
		if (this.map.has(key)) return this.map.get(key);

		const flash = flashKey(key);
		if (this.map.has(flash)) {
			const value = this.map.get(flash);
			this.map.delete(flash);
			this.dirty = true;
			return value;
		}

		return undefined;
	}

	/** Sets `value` for `key` (retrievable via `get` on subsequent requests as well). */
	set(key: string, value: unknown): void {
		this.map.set(key, value);
		this.dirty = true;
	}

	/** Sets `value` for `key`. It is consumed and disappears the next time `get(key)` is called (consume-once). */
	flash(key: string, value: unknown): void {
		this.map.set(flashKey(key), value);
		this.dirty = true;
	}

	/** Deletes the value for `key`. */
	unset(key: string): void {
		this.map.delete(key);
		this.dirty = true;
	}

	/**
	 * Requests that the session id be reissued on the next `commit`, as a defense
	 * against session fixation attacks. Call this when you want to keep the held data
	 * and flash values but issue a fresh id only (e.g. on successful login). Calling
	 * this marks the session dirty and makes `needsRegeneration` `true`.
	 */
	regenerate(): void {
		this.regenerationRequested = true;
		this.dirty = true;
	}

	/** Whether `regenerate()` has been called and the id needs to be reissued on the next `commit`. */
	get needsRegeneration(): boolean {
		return this.regenerationRequested;
	}

	/**
	 * Called by a concrete `SessionStorage` implementation after it has finished
	 * rotating the id in `commit`. Application code is not expected to call this.
	 */
	acknowledgeRegeneration(): void {
		this.regenerationRequested = false;
	}

	/**
	 * Called by a concrete `SessionStorage` implementation from within `destroy`.
	 * Application code is not expected to call this. Once set, the session is excluded
	 * from `SessionAccessor`'s automatic commit regardless of `isDirty` — destroy always
	 * wins, even if `set`/`flash` mutated this instance earlier in the same request.
	 */
	markDestroyed(): void {
		this.destroyed = true;
	}
}
