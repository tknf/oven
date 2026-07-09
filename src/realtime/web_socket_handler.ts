/**
 * The WebSocket upgrade mechanism itself (`upgradeWebSocket` from
 * `hono/cloudflare-workers`, `@hono/node-ws`, etc.) differs per runtime, and
 * per the principle "do not abstract the execution platform itself for a
 * specific platform," oven does not reimplement it. What is abstracted is the
 * more general concept above it, namely "how per-connection event hooks are
 * wired up."
 *
 * `UpgradeWebSocket`'s type definition (`hono/ws`) fixes the `createEvents`
 * callback's argument to a plain `Context` (the default `Env`), and it does not
 * propagate to the caller's `Env` type parameter. This is a constraint of
 * Hono's own type design, so the boundary is absorbed by casting to
 * `Context<E>` exactly once inside `middleware` (so the hook bodies themselves
 * can receive `Context<E>` as-is).
 */
import type { Context, Env, MiddlewareHandler } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents, WSMessageReceive } from "hono/ws";

export abstract class WebSocketHandler<E extends Env = Env> {
	/**
	 * Hook called when the connection is established. No-op by default;
	 * subclasses override only the ones they need. Wiring happens from the base
	 * class's `middleware` (an arrow function field, not the constructor), but
	 * the hook itself must be written as a prototype method since it is meant to
	 * be overridden.
	 */
	protected onOpen(_c: Context<E>, _evt: Event, _ws: WSContext): void | Promise<void> {}

	/** Hook called when a message is received. No-op by default. */
	protected onMessage(
		_c: Context<E>,
		_evt: MessageEvent<WSMessageReceive>,
		_ws: WSContext,
	): void | Promise<void> {}

	/** Hook called on disconnect. No-op by default. */
	protected onClose(_c: Context<E>, _evt: CloseEvent, _ws: WSContext): void | Promise<void> {}

	/** Hook called on error. No-op by default. */
	protected onError(_c: Context<E>, _evt: Event, _ws: WSContext): void | Promise<void> {}

	/**
	 * Takes the runtime's `upgradeWebSocket` (injected from
	 * `hono/cloudflare-workers`, `@hono/node-ws`, etc.) and returns a Hono
	 * middleware wired up to each hook.
	 *
	 * ```ts
	 * app.get("/ws", handler.middleware(upgradeWebSocket));
	 * ```
	 *
	 * `c` is passed as the first argument to each hook so that hooks can access
	 * the session/DI at upgrade time (values registered via `ContextAccessor`,
	 * etc.). Like `register`/`use`, this is passed by reference and called from
	 * the caller (inside the `upgradeWebSocket` implementation) detached from
	 * `this`, so it is kept as an arrow function class field to preserve `this` binding.
	 */
	readonly middleware = <T, U, WSE extends WSEvents<T>>(
		upgradeWebSocket: UpgradeWebSocket<T, U, WSE>,
	): MiddlewareHandler<E> =>
		upgradeWebSocket((c) => {
			const context = c as Context<E>;
			return {
				onOpen: (evt, ws) => this.onOpen(context, evt, ws),
				onMessage: (evt, ws) => this.onMessage(context, evt, ws),
				onClose: (evt, ws) => this.onClose(context, evt, ws),
				onError: (evt, ws) => this.onError(context, evt, ws),
			} as WSE;
		});
}
