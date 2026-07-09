/**
 * Verifies `InMemoryBroadcaster` (a `Broadcaster` implementation for
 * development, testing, and single-process use): the publish/subscribe
 * round trip, unsubscribe, channel isolation, and listener exception isolation.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { InMemoryBroadcaster } from "../../src/realtime/in_memory_broadcaster.js";

describe("InMemoryBroadcaster", () => {
	test("delivers published content to subscribed listeners", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const listener = vi.fn();
		broadcaster.subscribe("room:1", listener);

		await broadcaster.publish("room:1", { data: "hello" });

		expect(listener).toHaveBeenCalledWith({ data: "hello" });
	});

	test("does not deliver to a listener after unsubscribe", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const listener = vi.fn();
		const unsubscribe = broadcaster.subscribe("room:1", listener);
		unsubscribe();

		await broadcaster.publish("room:1", { data: "hello" });

		expect(listener).not.toHaveBeenCalled();
	});

	test("does not deliver to a listener on a different channel", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const listener = vi.fn();
		broadcaster.subscribe("room:1", listener);

		await broadcaster.publish("room:2", { data: "hello" });

		expect(listener).not.toHaveBeenCalled();
	});

	test("an exception in one listener does not break other listener calls or the publish caller", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const failing = vi.fn(() => {
			throw new Error("boom");
		});
		const succeeding = vi.fn();
		broadcaster.subscribe("room:1", failing);
		broadcaster.subscribe("room:1", succeeding);

		await expect(broadcaster.publish("room:1", { data: "hello" })).resolves.toBeUndefined();

		expect(succeeding).toHaveBeenCalledWith({ data: "hello" });
	});

	test("calls onListenerError when an exception occurs", async () => {
		const onListenerError = vi.fn();
		const broadcaster = new InMemoryBroadcaster({ onListenerError });
		const error = new Error("boom");
		broadcaster.subscribe("room:1", () => {
			throw error;
		});

		await broadcaster.publish("room:1", { data: "hello" });

		expect(onListenerError).toHaveBeenCalledWith(error, "room:1");
	});
});
