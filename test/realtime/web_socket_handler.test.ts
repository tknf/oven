/**
 * Verifies `WebSocketHandler` (the abstract base for wiring hooks) and
 * `BroadcastWebSocket` (its integration with `Broadcaster`). Since a real
 * runtime upgrade mechanism is unnecessary, this uses a **fake
 * upgradeWebSocket** that simply captures the `WSEvents` returned by
 * `createEvents`. `hono/ws`'s `UpgradeWebSocket` is an interface with two
 * call signatures ("returns a middleware" and "upgrades immediately"), but
 * since both oven and the real runtime adapters only use the former, the
 * fake implements only that form and matches the type with
 * `as UpgradeWebSocket`.
 */
import type { Context, Next } from "hono";
import { Hono } from "hono";
import type { UpgradeWebSocket, WSContext, WSEvents } from "hono/ws";
import { describe, expect, test, vi } from "vite-plus/test";
import { BroadcastWebSocket } from "../../src/realtime/broadcast_web_socket.js";
import { InMemoryBroadcaster } from "../../src/realtime/in_memory_broadcaster.js";
import { WebSocketHandler } from "../../src/realtime/web_socket_handler.js";

/**
 * A fake that simply calls `createEvents(c)` and captures the resulting
 * `WSEvents` along with the `Context` at that time. Hitting the route via
 * `app.request` verifies the wiring through a real `Context`.
 */
const createFakeUpgradeWebSocket = () => {
	let captured: WSEvents | undefined;
	let capturedContext: Context | undefined;
	const upgradeWebSocket = ((createEvents: (c: Context) => WSEvents | Promise<WSEvents>) => {
		return async (c: Context, next: Next) => {
			capturedContext = c;
			captured = await createEvents(c);
			await next();
		};
	}) as UpgradeWebSocket;
	return { upgradeWebSocket, getCaptured: () => captured, getContext: () => capturedContext };
};

/**
 * A stub that satisfies only the minimal members required by `hono/ws`'s
 * `WSContext`. Returns the `send` mock itself (passing a property-accessed
 * value like `ws.send` directly to `expect` triggers oxlint's
 * `unbound-method` warning, so the mock is held in a variable and used for
 * the assertion instead — same convention as `test/jobs/queue.test.ts`).
 */
const createStubWSContext = () => {
	const send = vi.fn();
	const close = vi.fn();
	const ws: WSContext = {
		send,
		close,
		raw: undefined,
		binaryType: "arraybuffer",
		readyState: 1,
		url: null,
		protocol: null,
	};
	return { ws, send, close };
};

describe("WebSocketHandler", () => {
	test("calls onOpen/onMessage/onClose with c and ws via middleware", async () => {
		const opened: Array<{ path: string; ws: WSContext }> = [];
		const messaged: Array<{ data: unknown; ws: WSContext }> = [];
		const closed: Array<{ ws: WSContext }> = [];

		class RecordingHandler extends WebSocketHandler {
			protected onOpen(c: Context, _evt: Event, ws: WSContext): void {
				opened.push({ path: c.req.path, ws });
			}
			protected onMessage(_c: Context, evt: MessageEvent, ws: WSContext): void {
				messaged.push({ data: evt.data, ws });
			}
			protected onClose(_c: Context, _evt: CloseEvent, ws: WSContext): void {
				closed.push({ ws });
			}
		}

		const handler = new RecordingHandler();
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		if (!events?.onOpen || !events.onMessage || !events.onClose) {
			throw new Error("WSEvents was not captured");
		}

		const { ws } = createStubWSContext();
		events.onOpen(new Event("open"), ws);
		events.onMessage(new MessageEvent("message", { data: "hello" }), ws);
		events.onClose(new CloseEvent("close"), ws);

		expect(opened).toEqual([{ path: "/ws", ws }]);
		expect(messaged).toEqual([{ data: "hello", ws }]);
		expect(closed).toEqual([{ ws }]);
	});

	test("does not throw when calling a hook that is left as the default no-op", async () => {
		class NoopHandler extends WebSocketHandler {}

		const handler = new NoopHandler();
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws } = createStubWSContext();

		expect(() => events?.onOpen?.(new Event("open"), ws)).not.toThrow();
		expect(() => events?.onError?.(new Event("error"), ws)).not.toThrow();
	});
});

describe("BroadcastWebSocket", () => {
	test("sends content published after open to ws using the default serialize (m.data)", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({ broadcaster, channels: () => ["room:1"] });
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send } = createStubWSContext();
		events?.onOpen?.(new Event("open"), ws);

		await broadcaster.publish("room:1", { data: "hello" });

		expect(send).toHaveBeenCalledWith("hello");
	});

	test("unsubscribes after close, so publish is not delivered", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({ broadcaster, channels: () => ["room:1"] });
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send } = createStubWSContext();
		events?.onOpen?.(new Event("open"), ws);
		events?.onClose?.(new CloseEvent("close"), ws);

		await broadcaster.publish("room:1", { data: "hello" });

		expect(send).not.toHaveBeenCalled();
	});

	test("does not double-unsubscribe even if both onClose and onError are called", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({ broadcaster, channels: () => ["room:1"] });
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send } = createStubWSContext();
		events?.onOpen?.(new Event("open"), ws);

		expect(() => {
			events?.onClose?.(new CloseEvent("close"), ws);
			events?.onError?.(new Event("error"), ws);
		}).not.toThrow();

		await broadcaster.publish("room:1", { data: "hello" });
		expect(send).not.toHaveBeenCalled();
	});

	test("two connections subscribe and unsubscribe independently", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({ broadcaster, channels: () => ["room:1"] });
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const eventsForFirst = getCaptured();
		const { ws: ws1, send: send1 } = createStubWSContext();
		eventsForFirst?.onOpen?.(new Event("open"), ws1);

		await app.request("/ws");
		const eventsForSecond = getCaptured();
		const { ws: ws2, send: send2 } = createStubWSContext();
		eventsForSecond?.onOpen?.(new Event("open"), ws2);

		eventsForFirst?.onClose?.(new CloseEvent("close"), ws1);
		await broadcaster.publish("room:1", { data: "hello" });

		expect(send1).not.toHaveBeenCalled();
		expect(send2).toHaveBeenCalledWith("hello");
	});

	test("does not subscribe and calls ws.close when authorize returns false", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({
			broadcaster,
			channels: () => ["room:1"],
			authorize: () => false,
		});
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send, close } = createStubWSContext();
		await Promise.resolve(events?.onOpen?.(new Event("open"), ws));

		expect(close).toHaveBeenCalledWith(1008, "Policy Violation");

		await broadcaster.publish("room:1", { data: "hello" });
		expect(send).not.toHaveBeenCalled();
	});

	test("subscribes as before when authorize returns true", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({
			broadcaster,
			channels: () => ["room:1"],
			authorize: async () => true,
		});
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send, close } = createStubWSContext();
		await Promise.resolve(events?.onOpen?.(new Event("open"), ws));

		expect(close).not.toHaveBeenCalled();

		await broadcaster.publish("room:1", { data: "hello" });
		expect(send).toHaveBeenCalledWith("hello");
	});

	test("subscribes without authorization as before when authorize is omitted", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({ broadcaster, channels: () => ["room:1"] });
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send, close } = createStubWSContext();
		await Promise.resolve(events?.onOpen?.(new Event("open"), ws));

		expect(close).not.toHaveBeenCalled();

		await broadcaster.publish("room:1", { data: "hello" });
		expect(send).toHaveBeenCalledWith("hello");
	});

	test("can transform and send the entire BroadcastMessage when serialize is specified", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const handler = new BroadcastWebSocket({
			broadcaster,
			channels: () => ["room:1"],
			serialize: (message) => JSON.stringify(message),
		});
		const { upgradeWebSocket, getCaptured } = createFakeUpgradeWebSocket();
		const app = new Hono();
		app.get("/ws", handler.middleware(upgradeWebSocket));

		await app.request("/ws");
		const events = getCaptured();
		const { ws, send } = createStubWSContext();
		events?.onOpen?.(new Event("open"), ws);

		await broadcaster.publish("room:1", { data: "hello", event: "message" });

		expect(send).toHaveBeenCalledWith(JSON.stringify({ data: "hello", event: "message" }));
	});
});
