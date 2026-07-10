/**
 * Integration test running `DurableObjectBroadcaster` +
 * `BroadcasterDurableObject` against real workerd Durable Objects
 * (docs/testing.md L3; `env.BROADCASTER` comes from the `wrangler.jsonc`
 * binding, and the class is exported from `main`, see
 * `test/workers/test_worker.ts`).
 *
 * `subscribe` returns synchronously while the WebSocket to the Durable
 * Object is still connecting (see the class doc comment for the resulting
 * gap), so every delivery test inserts a short real-time `sleep` after
 * `subscribe` to let the connection settle before `publish`, then awaits
 * delivery with `vi.waitFor` — the same idiom used by the DB-backed
 * broadcaster tests (`test/realtime/sqlite_database_broadcaster.test.ts`).
 * Real timers throughout; fake timers don't mix with a real network round
 * trip to the Durable Object.
 *
 * The reconnection tests below drive a disconnect by making the *subscribe*
 * handshake itself fail a controlled number of times, rather than by closing
 * an already-open socket: closing a hibernatable Durable Object WebSocket
 * from the client side was tried first, but its local `close` event never
 * completed within several seconds in this test harness (`readyState` got
 * stuck at `CLOSING`), so it is not a reliable way to reproduce a disconnect
 * here (see the final report for detail; this is a harness limitation, not
 * something specific to `DurableObjectBroadcaster`). Failing the handshake
 * exercises the exact same `scheduleReconnect` path a live disconnect would
 * (`connect`'s `catch`/no-`webSocket` branches call `hooks.onClose` exactly
 * like a real close/error event would), so it still exercises the real
 * state machine end to end. `withFailingSubscribes` wraps the real
 * `DurableObjectNamespace` binding so the first `failCount` WebSocket-upgrade
 * `fetch` calls through it reject before reaching the Durable Object.
 */
import { env } from "cloudflare:workers";
import { describe, expect, test, vi } from "vite-plus/test";
import type { BroadcastMessage } from "../../src/realtime/broadcaster.js";
import { DurableObjectBroadcaster } from "../../src/cloudflare/durable_object_broadcaster.js";

/** Waits `ms` milliseconds of real time. A test-only helper to let the WebSocket handshake settle. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps `namespace` so the first `failCount` WebSocket-upgrade `fetch` calls
 * through it reject instead of reaching the Durable Object, and every
 * subsequent one passes through unchanged. `getAttempts` reports the total
 * number of upgrade attempts made so far, including the failed ones (see the
 * module doc comment for why the reconnection tests drive a disconnect this
 * way instead of closing a live socket).
 */
const withFailingSubscribes = (
	namespace: DurableObjectNamespace,
	failCount: number,
): { namespace: DurableObjectNamespace; getAttempts: () => number } => {
	let attempts = 0;
	let remainingFailures = failCount;
	const wrapped: DurableObjectNamespace = {
		newUniqueId: (options) => namespace.newUniqueId(options),
		idFromName: (name) => namespace.idFromName(name),
		idFromString: (id) => namespace.idFromString(id),
		getByName: (name, options) => namespace.getByName(name, options),
		jurisdiction: (jurisdiction) => namespace.jurisdiction(jurisdiction),
		get: (id, options) => {
			const stub = namespace.get(id, options);
			return new Proxy(stub, {
				get: (target, prop, receiver) => {
					if (prop === "fetch") {
						return async (input: RequestInfo | URL, init?: RequestInit) => {
							if (new Headers(init?.headers).get("Upgrade") === "websocket") {
								attempts += 1;
								if (remainingFailures > 0) {
									remainingFailures -= 1;
									throw new Error("simulated connect failure");
								}
							}
							return target.fetch(input, init);
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
	return { namespace: wrapped, getAttempts: () => attempts };
};

describe("DurableObjectBroadcaster", () => {
	test("delivers a published message to a subscribed listener", async () => {
		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER);
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:1", (message) => received.push(message));
		await sleep(100);

		await broadcaster.publish("room:1", { data: "hello" });

		await vi.waitFor(() => expect(received).toEqual([{ data: "hello" }]), {
			timeout: 2000,
			interval: 20,
		});
	});

	test("does not deliver to a listener after unsubscribe", async () => {
		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER);
		const received: BroadcastMessage[] = [];
		const unsubscribe = broadcaster.subscribe("room:2", (message) => received.push(message));
		await sleep(100);

		unsubscribe();
		await broadcaster.publish("room:2", { data: "after-unsubscribe" });

		await sleep(200);
		expect(received).toEqual([]);
	});

	test("delivers correctly to each of two subscribed channels and not to an unrelated channel", async () => {
		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER);
		const roomA: BroadcastMessage[] = [];
		const roomB: BroadcastMessage[] = [];
		broadcaster.subscribe("room:3a", (message) => roomA.push(message));
		broadcaster.subscribe("room:3b", (message) => roomB.push(message));
		await sleep(100);

		await broadcaster.publish("room:3a", { data: "for-a" });
		await broadcaster.publish("room:3b", { data: "for-b" });
		await broadcaster.publish("room:3-unrelated", { data: "for-nobody" });

		await vi.waitFor(
			() => {
				expect(roomA).toEqual([{ data: "for-a" }]);
				expect(roomB).toEqual([{ data: "for-b" }]);
			},
			{ timeout: 2000, interval: 20 },
		);
	});

	test("delivery to other listeners continues, and onListenerError is called, when a listener throws", async () => {
		const onListenerError = vi.fn();
		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER, { onListenerError });
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:4", () => {
			throw new Error("internal listener error");
		});
		broadcaster.subscribe("room:4", (message) => received.push(message));
		await sleep(100);

		await broadcaster.publish("room:4", { data: "hello" });

		await vi.waitFor(() => expect(received).toEqual([{ data: "hello" }]), {
			timeout: 2000,
			interval: 20,
		});
		expect(onListenerError).toHaveBeenCalledWith(expect.any(Error), "room:4");
	});

	test("publish does not throw when there are no subscribers", async () => {
		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER);

		await expect(
			broadcaster.publish("room:5-nobody-listening", { data: "hello" }),
		).resolves.toBeUndefined();
	});

	test("a malformed publish body is rejected with 400 and does not disturb a subsequent valid publish", async () => {
		const channel = "room:6";
		const id = env.BROADCASTER.idFromName(channel);
		const stub = env.BROADCASTER.get(id);

		const malformed = await stub.fetch("https://broadcaster/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ notData: "wrong shape" }),
		});
		expect(malformed.status).toBe(400);

		const broadcaster = new DurableObjectBroadcaster(env.BROADCASTER);
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe(channel, (message) => received.push(message));
		await sleep(100);

		await broadcaster.publish(channel, { data: "still-works" });

		await vi.waitFor(() => expect(received).toEqual([{ data: "still-works" }]), {
			timeout: 2000,
			interval: 20,
		});
	});

	test("retries a failed connection with backoff, then reconnects and resumes delivery", async () => {
		const { namespace, getAttempts } = withFailingSubscribes(env.BROADCASTER, 2);
		const onDisconnect = vi.fn();
		const onReconnect = vi.fn();
		const broadcaster = new DurableObjectBroadcaster(namespace, {
			onDisconnect,
			onReconnect,
			reconnectInitialDelayMs: 20,
			reconnectMaxDelayMs: 50,
		});
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:reconnect-1", (message) => received.push(message));

		// 2 simulated failures before the 3rd attempt succeeds.
		await vi.waitFor(() => expect(onReconnect).toHaveBeenCalledWith(2, "room:reconnect-1"), {
			timeout: 2000,
			interval: 20,
		});
		expect(getAttempts()).toBe(3);
		expect(onDisconnect).toHaveBeenNthCalledWith(1, 1, expect.any(Error), "room:reconnect-1");
		expect(onDisconnect).toHaveBeenNthCalledWith(2, 2, expect.any(Error), "room:reconnect-1");

		await broadcaster.publish("room:reconnect-1", { data: "after-reconnect" });
		await vi.waitFor(() => expect(received).toEqual([{ data: "after-reconnect" }]), {
			timeout: 2000,
			interval: 20,
		});
	});

	test("unsubscribe stops further reconnect attempts", async () => {
		const { namespace, getAttempts } = withFailingSubscribes(env.BROADCASTER, 100);
		const onDisconnect = vi.fn();
		// A backoff delay much longer than the `waitFor` poll interval below
		// leaves a comfortable window to call `unsubscribe` well before the
		// pending retry would otherwise fire, avoiding a race between the two.
		const broadcaster = new DurableObjectBroadcaster(namespace, {
			onDisconnect,
			reconnectInitialDelayMs: 300,
			reconnectMaxDelayMs: 300,
		});
		const unsubscribe = broadcaster.subscribe("room:reconnect-2", () => {});

		await vi.waitFor(() => expect(onDisconnect).toHaveBeenCalledTimes(1), {
			timeout: 2000,
			interval: 10,
		});
		unsubscribe();
		const attemptsAtUnsubscribe = getAttempts();

		await sleep(500);
		expect(getAttempts()).toBe(attemptsAtUnsubscribe);
	});

	test("with reconnect: false, a failed connection ends the subscription for good (original behavior)", async () => {
		const { namespace, getAttempts } = withFailingSubscribes(env.BROADCASTER, 100);
		const broadcaster = new DurableObjectBroadcaster(namespace, { reconnect: false });
		const received: BroadcastMessage[] = [];
		broadcaster.subscribe("room:reconnect-3", (message) => received.push(message));

		await sleep(200);
		expect(getAttempts()).toBe(1);

		await broadcaster.publish("room:reconnect-3", { data: "should-not-arrive" });
		await sleep(150);
		expect(received).toEqual([]);
	});
});
