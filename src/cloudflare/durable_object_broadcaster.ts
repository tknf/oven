/**
 * `Broadcaster` implementation backed by Cloudflare Durable Objects, for
 * delivery across every Worker instance in a multi-instance deployment (the
 * gap `InMemoryBroadcaster` explicitly does not fill — see its doc comment).
 * A channel maps one-to-one onto a DO instance (`namespace.idFromName(channel)`);
 * the DO itself (`BroadcasterDurableObject`, `broadcaster_durable_object.ts`)
 * fans a published message out to every WebSocket currently accepted by that
 * instance.
 *
 * Requires `BroadcasterDurableObject` to be wired into your Worker yourself
 * (re-exported from the entry point, bound in `wrangler.jsonc`) — see that
 * class's doc comment for the exact wiring. This class only takes the
 * resulting `DurableObjectNamespace` via constructor injection.
 *
 * **`publish` error behavior mirrors the database-backed `Broadcaster`
 * adapters** (`SQLiteDatabaseBroadcaster` and friends): a failure talking to
 * the backing store (here, the DO `fetch` call rejecting or returning a
 * non-2xx status) is not swallowed — it propagates out of `publish` — since
 * those adapters propagate DB errors the same way. The `Broadcaster` base
 * contract's "must not throw even with zero subscribers" still holds: the DO
 * accepts and 204s a publish regardless of how many sockets are currently
 * connected.
 *
 * **`subscribe`'s synchronous contract creates a connection-establishment
 * gap.** `Broadcaster#subscribe` must return an unsubscribe function
 * synchronously, but opening the WebSocket to the DO is inherently
 * asynchronous. Any `publish` that lands between the `subscribe` call
 * returning and the WebSocket finishing its handshake is not delivered to
 * that listener — unlike `InMemoryBroadcaster`, which has no such gap. This
 * is still within the `Broadcaster` contract's at-most-once, best-effort
 * delivery guarantee, just a wider window than the in-process adapter.
 *
 * **No reconnection.** If the WebSocket to the DO closes for any reason
 * (the DO instance erroring, an infrastructure hiccup, etc.), that
 * subscription simply stops receiving messages — this adapter does not
 * retry or reconnect. It is intended to back a connection with its own
 * bounded lifetime (an SSE response, a client WebSocket) whose owner already
 * handles reconnecting from scratch; a persistent background subscription
 * would need that retry/backoff logic built on top.
 *
 * **Every `publish`/`subscribe` for a channel routes through the same DO
 * instance**, which is a single point of coordination (and billing unit) for
 * that channel — the same trade-off `BroadcasterDurableObject`'s doc comment
 * describes as "model around coordination atoms" in Cloudflare's Durable
 * Objects guidance. Fan a hot channel out across multiple DO instances
 * yourself (e.g. by sharding the channel name) if it becomes a bottleneck.
 */
import type { BroadcastMessage } from "../realtime/broadcaster.js";
import { Broadcaster } from "../realtime/broadcaster.js";

type Listener = (message: BroadcastMessage) => void;

export type DurableObjectBroadcasterOptions = {
	/** Called when a `listener` throws while handling a delivered message (a no-op by default). */
	onListenerError?: (error: unknown, channel: string) => void;
};

/** Narrows an untrusted JSON value received over the WebSocket to `BroadcastMessage`. */
const isBroadcastMessage = (value: unknown): value is BroadcastMessage => {
	if (typeof value !== "object" || value === null) return false;
	const { data, event } = value as Record<string, unknown>;
	if (typeof data !== "string") return false;
	return event === undefined || typeof event === "string";
};

export class DurableObjectBroadcaster extends Broadcaster {
	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly options: DurableObjectBroadcasterOptions = {},
	) {
		super();
	}

	/**
	 * Posts `message` to the channel's DO instance. Throws if the request
	 * itself fails (network error) or the DO responds with a non-2xx status
	 * (see the class doc comment for why this doesn't swallow errors).
	 */
	async publish(channel: string, message: BroadcastMessage): Promise<void> {
		const stub = this.namespace.get(this.namespace.idFromName(channel));
		const response = await stub.fetch("https://broadcaster/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(message),
		});

		if (!response.ok) {
			throw new Error(
				`DurableObjectBroadcaster: publish to "${channel}" failed (${response.status})`,
			);
		}
	}

	/**
	 * Starts connecting a WebSocket to the channel's DO instance and delivers
	 * every well-formed message it receives to `listener`. Returns immediately
	 * (see the class doc comment for the resulting connection-establishment
	 * gap); the connection itself is opened by a detached async task.
	 */
	subscribe(channel: string, listener: Listener): () => void {
		let cancelled = false;
		let socket: WebSocket | undefined;

		void this.connect(channel, listener, {
			isCancelled: () => cancelled,
			bind: (ws) => {
				socket = ws;
			},
		});

		return () => {
			cancelled = true;
			socket?.close();
		};
	}

	/**
	 * Opens the WebSocket and wires message delivery. A failure to connect at
	 * all (the `fetch` rejecting, or the DO not returning a WebSocket) is
	 * swallowed: `subscribe` has already returned synchronously with no
	 * caller left to propagate the error to, so the listener simply never
	 * receives anything.
	 */
	private async connect(
		channel: string,
		listener: Listener,
		hooks: { isCancelled: () => boolean; bind: (ws: WebSocket) => void },
	): Promise<void> {
		try {
			const stub = this.namespace.get(this.namespace.idFromName(channel));
			const response = await stub.fetch("https://broadcaster/subscribe", {
				headers: { Upgrade: "websocket" },
			});

			const ws = response.webSocket;
			if (!ws) return;

			// The Worker-side end of the pair still needs an explicit accept
			// (only the Durable Object side hibernates); this call activates it.
			ws.accept();

			if (hooks.isCancelled()) {
				ws.close();
				return;
			}
			hooks.bind(ws);

			ws.addEventListener("message", (event) => {
				if (typeof event.data !== "string") return;

				let body: unknown;
				try {
					body = JSON.parse(event.data);
				} catch {
					return;
				}
				if (!isBroadcastMessage(body)) return;

				try {
					listener(body);
				} catch (error) {
					this.options.onListenerError?.(error, channel);
				}
			});
		} catch {
			// See method doc comment: no synchronous caller remains to report to.
		}
	}
}
