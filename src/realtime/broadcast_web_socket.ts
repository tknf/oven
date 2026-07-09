/**
 * A `WebSocketHandler` subclass that connects `Broadcaster` channel subscriptions
 * to WebSocket connections. It is the WebSocket counterpart of `broadcastSse`
 * (the function helper in `sse.ts`), but since WebSocket connections have explicit
 * open/close hooks (`onOpen`/`onClose`/`onError`), it is expressed as a class.
 *
 * Per-connection unsubscribe functions are kept in a Map keyed by `WSContext`, so
 * that whichever of disconnect (`onClose`) or error (`onError`) happens first,
 * unsubscription always happens exactly once (preventing both double-unsubscribe
 * and leaks).
 */
import type { Context, Env } from "hono";
import type { WSContext } from "hono/ws";
import type { BroadcastMessage, Broadcaster } from "./broadcaster.js";
import { WebSocketHandler } from "./web_socket_handler.js";

export type BroadcastWebSocketOptions<E extends Env> = {
	/** The Broadcaster used for subscribing and publishing. */
	broadcaster: Broadcaster;
	/** Determines the per-connection subscribed channels from the Context (e.g. the session's user ID). */
	channels: (c: Context<E>) => string[];
	/**
	 * Converts a `BroadcastMessage` to the string sent over the wire. Defaults to
	 * `(m) => m.data` (technology-agnostic: HTML snippets and JSON strings are
	 * passed through as-is).
	 */
	serialize?: (message: BroadcastMessage) => string;
	/**
	 * Authorization check performed when the connection is established. If false,
	 * `channels` is not subscribed and the connection is closed with close code
	 * 1008 (Policy Violation).
	 *
	 * WebSocket is not subject to the Same-Origin Policy (SOP), and cookies are
	 * sent automatically on connection establishment. In the typical implementation
	 * where `channels` is derived from the session (e.g. a user ID), Cross-Site
	 * WebSocket Hijacking (a connection opened from a page on a different origin
	 * subscribing to that user's channels) can occur if `authorize` is not
	 * specified. If you omit `authorize`, perform Origin validation and
	 * authorization inside the `channels` callback.
	 */
	authorize?: (c: Context<E>) => boolean | Promise<boolean>;
};

export class BroadcastWebSocket<E extends Env = Env> extends WebSocketHandler<E> {
	private readonly unsubscribesByConnection = new Map<WSContext, Array<() => void>>();

	constructor(private readonly options: BroadcastWebSocketOptions<E>) {
		super();
	}

	protected async onOpen(c: Context<E>, _evt: Event, ws: WSContext): Promise<void> {
		if (this.options.authorize && !(await this.options.authorize(c))) {
			ws.close(1008, "Policy Violation");
			return;
		}

		const serialize = this.options.serialize ?? ((message: BroadcastMessage) => message.data);
		const unsubscribes = this.options
			.channels(c)
			.map((channel) =>
				this.options.broadcaster.subscribe(channel, (message) => ws.send(serialize(message))),
			);
		this.unsubscribesByConnection.set(ws, unsubscribes);
	}

	protected onClose(_c: Context<E>, _evt: CloseEvent, ws: WSContext): void {
		this.unsubscribeAll(ws);
	}

	protected onError(_c: Context<E>, _evt: Event, ws: WSContext): void {
		this.unsubscribeAll(ws);
	}

	/** Calls all unsubscribe functions and removes the entry from the Map. Tolerant of double-unsubscribe (does nothing if not registered). */
	private unsubscribeAll(ws: WSContext): void {
		const unsubscribes = this.unsubscribesByConnection.get(ws);
		if (!unsubscribes) return;
		for (const unsubscribe of unsubscribes) unsubscribe();
		this.unsubscribesByConnection.delete(ws);
	}
}
