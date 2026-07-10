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
 * delivery guarantee, just a wider window than the in-process adapter. This
 * gap cannot be closed without making `subscribe` asynchronous, which the
 * `Broadcaster` base contract does not allow (it returns the unsubscribe
 * function synchronously, with no promise to await); it reopens after every
 * automatic reconnect described below, for the same reason.
 *
 * **Automatic reconnection, still at-most-once delivery.** If the WebSocket
 * to the DO closes for any reason (the DO instance erroring, an
 * infrastructure hiccup, etc.), this adapter retries the connection with
 * exponential backoff (`reconnectInitialDelayMs`, doubling up to
 * `reconnectMaxDelayMs`) until it succeeds or `unsubscribe` is called — set
 * `reconnect: false` to opt back into the old behavior of leaving the
 * subscription dead once its socket closes. Reconnecting only restores the
 * subscription's liveness; it does not recover anything. A `publish` that
 * lands while the socket is down (or reconnecting) is never redelivered,
 * the same as any other gap covered by the `Broadcaster` base contract's
 * at-most-once guarantee. This is intended to back a *persistent*
 * subscription (e.g. one held by a `Broadcaster` singleton across many
 * requests); a subscription scoped to a single connection's lifetime (an SSE
 * response, a client WebSocket) whose owner already reconnects from scratch
 * can leave the default behavior as is or turn it off, since either one is
 * fine for that case.
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
	/**
	 * Called right before a reconnect attempt is scheduled for `channel`, i.e.
	 * once per disconnect while `reconnect` stays enabled. `attempt` is the
	 * 1-based number of the reconnect attempt about to be scheduled (it resets
	 * to 1 again after any reconnect succeeds). `error` is the failure that
	 * caused the disconnect when known (a rejected `fetch`/handshake, a
	 * WebSocket `error` event, or the DO not returning a WebSocket at all) and
	 * is `undefined` for a clean close.
	 */
	onDisconnect?: (attempt: number, error: unknown, channel: string) => void;
	/**
	 * Called once a reconnect attempt for `channel` succeeds. `attempt` matches
	 * the `onDisconnect` call whose retry this is.
	 */
	onReconnect?: (attempt: number, channel: string) => void;
	/**
	 * Set to `false` to disable automatic reconnection, restoring this
	 * adapter's original behavior: once a subscription's WebSocket closes, it
	 * stays closed for the life of the process. Defaults to enabled.
	 */
	reconnect?: false;
	/** Initial reconnect backoff delay in ms, doubled after every further attempt. Defaults to 1000. */
	reconnectInitialDelayMs?: number;
	/** Upper bound in ms the reconnect backoff delay is capped at. Defaults to 30000. */
	reconnectMaxDelayMs?: number;
};

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000;

/** Narrows an untrusted JSON value received over the WebSocket to `BroadcastMessage`. */
const isBroadcastMessage = (value: unknown): value is BroadcastMessage => {
	if (typeof value !== "object" || value === null) return false;
	const { data, event } = value as Record<string, unknown>;
	if (typeof data !== "string") return false;
	return event === undefined || typeof event === "string";
};

export class DurableObjectBroadcaster extends Broadcaster {
	private readonly reconnectEnabled: boolean;
	private readonly reconnectInitialDelayMs: number;
	private readonly reconnectMaxDelayMs: number;

	constructor(
		private readonly namespace: DurableObjectNamespace,
		private readonly options: DurableObjectBroadcasterOptions = {},
	) {
		super();
		this.reconnectEnabled = options.reconnect !== false;
		this.reconnectInitialDelayMs =
			options.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
		this.reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
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
	 *
	 * While `reconnect` stays enabled (the default), a disconnect schedules a
	 * retry with exponential backoff instead of ending the subscription (see
	 * the class doc comment "Automatic reconnection"). The returned
	 * unsubscribe function cancels any pending retry and closes the current
	 * socket, so no reconnect loop outlives it.
	 */
	subscribe(channel: string, listener: Listener): () => void {
		let cancelled = false;
		let socket: WebSocket | undefined;
		let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
		let attempt = 0;

		const scheduleReconnect = (error: unknown): void => {
			socket = undefined;
			if (cancelled || !this.reconnectEnabled) return;

			attempt += 1;
			this.options.onDisconnect?.(attempt, error, channel);

			const delay = Math.min(
				this.reconnectInitialDelayMs * 2 ** (attempt - 1),
				this.reconnectMaxDelayMs,
			);
			reconnectTimer = setTimeout(() => {
				reconnectTimer = undefined;
				connectOnce();
			}, delay);
		};

		const connectOnce = (): void => {
			void this.connect(channel, listener, {
				isCancelled: () => cancelled,
				bind: (ws) => {
					socket = ws;
					if (attempt > 0) this.options.onReconnect?.(attempt, channel);
					attempt = 0;
				},
				onClose: scheduleReconnect,
			});
		};
		connectOnce();

		return () => {
			cancelled = true;
			if (reconnectTimer !== undefined) {
				clearTimeout(reconnectTimer);
				reconnectTimer = undefined;
			}
			socket?.close();
		};
	}

	/**
	 * Opens the WebSocket and wires message delivery, reporting the outcome
	 * through `hooks.onClose` exactly once per call: with an `error` if the
	 * connection could not be established or later failed, or with `undefined`
	 * for a clean close. A failure to connect at all (the `fetch` rejecting,
	 * or the DO not returning a WebSocket) used to be swallowed silently
	 * before automatic reconnection existed; now it is reported the same way
	 * as a later disconnect so the caller can retry it.
	 */
	private async connect(
		channel: string,
		listener: Listener,
		hooks: {
			isCancelled: () => boolean;
			bind: (ws: WebSocket) => void;
			onClose: (error: unknown) => void;
		},
	): Promise<void> {
		let closeReported = false;
		const reportClose = (error: unknown): void => {
			if (closeReported) return;
			closeReported = true;
			hooks.onClose(error);
		};

		try {
			const stub = this.namespace.get(this.namespace.idFromName(channel));
			const response = await stub.fetch("https://broadcaster/subscribe", {
				headers: { Upgrade: "websocket" },
			});

			const ws = response.webSocket;
			if (!ws) {
				reportClose(
					new Error(`DurableObjectBroadcaster: subscribe to "${channel}" did not upgrade`),
				);
				return;
			}

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

			ws.addEventListener("close", () => reportClose(undefined));
			ws.addEventListener("error", () =>
				reportClose(new Error(`DurableObjectBroadcaster: WebSocket error on channel "${channel}"`)),
			);
		} catch (error) {
			reportClose(error);
		}
	}
}
