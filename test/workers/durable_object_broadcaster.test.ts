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
 */
import { env } from "cloudflare:workers";
import { describe, expect, test, vi } from "vite-plus/test";
import type { BroadcastMessage } from "../../src/realtime/broadcaster.js";
import { DurableObjectBroadcaster } from "../../src/cloudflare/durable_object_broadcaster.js";

/** Waits `ms` milliseconds of real time. A test-only helper to let the WebSocket handshake settle. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
});
