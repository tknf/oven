/**
 * Minimal abstraction for delivering messages to a channel. Formats tied to a
 * specific frontend technology (Turbo Streams, htmx SSE extension, etc.) are not
 * baked into the core. `BroadcastMessage.data` is treated as a plain,
 * technology-agnostic string that may be an HTML snippet or a JSON string
 * (interpretation is the caller's contract).
 *
 * Delivery is at-most-once (no retries, no persistence). Use cases that need
 * reliable processing (sending email, payment integration, etc.) are the
 * responsibility of `JobQueue`; `Broadcaster` only provides best-effort delivery
 * for real-time notifications.
 *
 * The scope reachable by `subscribe` is implementation-dependent. `InMemoryBroadcaster`
 * only reaches `publish` calls within the same process. Delivery in multi-instance
 * environments (multi-process, multi-region) is the responsibility of other adapters
 * (the DB-backed `{Pg,SQLite,MySql}DatabaseBroadcaster`s, and `DurableObjectBroadcaster`
 * in `@tknf/oven/cloudflare`), and this abstraction itself does not depend on any of them.
 */
export type BroadcastMessage = {
	/** Message body. Format (HTML snippet, JSON string, etc.) is the caller's contract. */
	data: string;
	/** Optional event name. Only used by protocols that support it, such as the SSE `event` field. */
	event?: string;
};

export abstract class Broadcaster {
	/** Delivers `message` to `channel`. Must not throw even if there are no subscribers. */
	abstract publish(channel: string, message: BroadcastMessage): Promise<void>;

	/**
	 * Starts subscribing to `channel` and delivers messages to `listener`. Calling
	 * the returned function unsubscribes. It is the implementation's responsibility
	 * to prevent an exception thrown inside `listener` from propagating to other
	 * listener invocations or to the `publish` caller.
	 */
	abstract subscribe(channel: string, listener: (message: BroadcastMessage) => void): () => void;
}
