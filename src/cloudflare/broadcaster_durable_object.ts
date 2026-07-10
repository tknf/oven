/**
 * Durable Object that implements the server side consumed by
 * `DurableObjectBroadcaster` (`durable_object_broadcaster.ts`). One DO
 * instance backs exactly one channel (the Worker looks it up via
 * `namespace.idFromName(channel)`), so a single instance never needs to
 * track which of its connections belongs to which channel — every
 * WebSocket it accepts already belongs to this instance's channel.
 *
 * Written as a legacy `implements DurableObject` class rather than
 * `extends DurableObject` from `cloudflare:workers`, so this file — like
 * every other adapter under `src/cloudflare/` — only depends on ambient
 * `@cloudflare/workers-types` globals and never imports `cloudflare:workers`.
 * That keeps it safe to import from a Node process (e.g. a test runner)
 * without a Workers runtime present.
 *
 * **Wiring is the app's responsibility (no magic).** oven does not write
 * your `wrangler.jsonc`. Re-export this class from your Worker's entry
 * point and declare the binding and migration yourself:
 *
 * ```ts
 * // src/worker.ts
 * export { BroadcasterDurableObject } from "@tknf/oven/cloudflare";
 * ```
 *
 * ```jsonc
 * // wrangler.jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "BROADCASTER", "class_name": "BroadcasterDurableObject" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_sqlite_classes": ["BroadcasterDurableObject"] }]
 * }
 * ```
 */
import type { BroadcastMessage } from "../realtime/broadcaster.js";

/** Narrows an untrusted JSON value to `BroadcastMessage` (`data` must be a string; `event`, if present, must be a string). */
const isBroadcastMessage = (value: unknown): value is BroadcastMessage => {
	if (typeof value !== "object" || value === null) return false;
	const { data, event } = value as Record<string, unknown>;
	if (typeof data !== "string") return false;
	return event === undefined || typeof event === "string";
};

export class BroadcasterDurableObject implements DurableObject {
	constructor(private readonly state: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			return this.handleSubscribe();
		}
		if (request.method === "POST") {
			return this.handlePublish(request);
		}
		return new Response("Method Not Allowed", { status: 405 });
	}

	/**
	 * Accepts the WebSocket through the Hibernation API (`state.acceptWebSocket`,
	 * not `server.accept()`), so this instance can be evicted from memory
	 * between messages without dropping the connection — a hibernated instance
	 * is re-initialized (its constructor runs again) the next time a message
	 * arrives on the socket.
	 */
	private handleSubscribe(): Response {
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		this.state.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	/**
	 * Validates the request body and fans it out to every WebSocket currently
	 * accepted by this instance. Rejects a malformed body with 400 instead of
	 * forwarding it, since `webSocketMessage`/subscribers on the other end
	 * expect a well-formed `BroadcastMessage`. A `send` failure on one socket
	 * (e.g. it is mid-close) is swallowed so it does not block delivery to the
	 * others.
	 */
	private async handlePublish(request: Request): Promise<Response> {
		const body: unknown = await request.json().catch(() => null);
		if (!isBroadcastMessage(body)) {
			return new Response("Invalid broadcast message", { status: 400 });
		}

		const payload = JSON.stringify(body);
		for (const socket of this.state.getWebSockets()) {
			try {
				socket.send(payload);
			} catch {
				// One failing socket (e.g. already closing) must not block delivery to the others.
			}
		}

		return new Response(null, { status: 204 });
	}

	/**
	 * Hibernation callback for an incoming frame. Subscribers created by
	 * `DurableObjectBroadcaster` never send anything, but a socket connected to
	 * this instance by other means could — and workerd raises an error (rather
	 * than silently dropping the frame) when a hibernatable socket receives a
	 * message and the class defines no handler, the same runtime strictness that
	 * makes `webSocketClose` below mandatory. Stray frames are ignored.
	 */
	webSocketMessage(_ws: WebSocket, _message: ArrayBuffer | string): void {}

	/**
	 * Hibernation callback fired when a subscriber's connection closes. There is
	 * no per-connection state to clean up here (see the class doc comment — a
	 * channel's subscriber list is just "whatever `getWebSockets` currently
	 * returns"), so this only completes the close handshake. `ws.close` is
	 * wrapped in a `try`/`catch` because the `code` the runtime reports here can
	 * be a value that isn't valid to send back in a Close frame (e.g. `1005`,
	 * "no status received"); that's harmless to ignore since the runtime already
	 * completes the handshake itself by default (the `web_socket_auto_reply_to_close`
	 * compatibility flag, on for compatibility dates on or after 2026-04-07).
	 */
	webSocketClose(ws: WebSocket, code: number, reason: string): void {
		try {
			ws.close(code, reason);
		} catch {
			// See method doc comment.
		}
	}

	/** Hibernation callback for a socket-level error. No per-connection state to clean up (see the class doc comment). */
	webSocketError(_ws: WebSocket, _error: unknown): void {}
}
