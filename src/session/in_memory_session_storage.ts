/**
 * A `SessionStorage` implementation for development and testing. Simply keeps
 * sessions in an in-process `Map` keyed by session id, with no persistence (the same
 * role as `in_memory_key_value_store.ts`).
 *
 * **Decision to not support TTL**: unlike `KeyValueSessionStorage`, this class does not
 * implement TTL or sliding refresh. This is a deliberate choice not to add
 * functionality beyond this class's role as "the simplest reference implementation for
 * development and testing" (verifying expiry logic belongs to `KeyValueSessionStorage`'s
 * tests). If you need to test expiry behavior, use `KeyValueSessionStorage` combined
 * with `InMemoryKeyValueStore`.
 */
import type { SessionData } from "./session.js";
import { Session } from "./session.js";
import { generateSessionId } from "./session_storage.js";
import { SessionStorage } from "./session_storage.js";

export class InMemorySessionStorage extends SessionStorage {
	private readonly store = new Map<string, SessionData>();

	async get(cookieHeader: string | null): Promise<Session> {
		const id = this.readSessionCookie(cookieHeader);
		if (!id) return new Session("");

		const data = this.store.get(id);
		return data ? new Session(id, data) : new Session("");
	}

	/**
	 * When `session.needsRegeneration` is set, issues a new id as a defense against
	 * session fixation attacks, deletes the entry under the old id, and saves under
	 * the new id (never leaving the old id behind).
	 */
	async commit(session: Session): Promise<string> {
		const oldId = session.id;
		const id = session.needsRegeneration || !oldId ? generateSessionId() : oldId;

		if (session.needsRegeneration && oldId) this.store.delete(oldId);
		this.store.set(id, session.data);
		session.acknowledgeRegeneration();

		return this.buildCommitCookie(id);
	}

	async destroy(session: Session): Promise<string> {
		if (session.id) this.store.delete(session.id);

		return this.buildDestroyCookie();
	}
}
