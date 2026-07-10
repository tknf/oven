/**
 * Verifies `TestBroadcaster`, the test `Broadcaster` implementation provided by
 * `@tknf/oven/test`. Checks the recorded publish contents, channel-filtered
 * retrieval via `publishedTo`, `clear()`, and delivery to subscribed listeners.
 */
import { describe, expect, test, vi } from "vite-plus/test";
import { TestBroadcaster } from "../../src/test/test_broadcaster.js";

describe("TestBroadcaster", () => {
	test("published content accumulates in published", async () => {
		const broadcaster = new TestBroadcaster();

		await broadcaster.publish("room:1", { data: "hello" });

		expect(broadcaster.published).toEqual([{ channel: "room:1", message: { data: "hello" } }]);
	});

	test("publishedTo returns only a specific channel's messages, in order", async () => {
		const broadcaster = new TestBroadcaster();

		await broadcaster.publish("room:1", { data: "first" });
		await broadcaster.publish("room:2", { data: "other" });
		await broadcaster.publish("room:1", { data: "second" });

		expect(broadcaster.publishedTo("room:1")).toEqual([{ data: "first" }, { data: "second" }]);
	});

	test("publishedTo excludes other channels' records", async () => {
		const broadcaster = new TestBroadcaster();

		await broadcaster.publish("room:2", { data: "other" });

		expect(broadcaster.publishedTo("room:1")).toEqual([]);
	});

	test("clear() clears the published records", async () => {
		const broadcaster = new TestBroadcaster();
		await broadcaster.publish("room:1", { data: "hello" });

		broadcaster.clear();

		expect(broadcaster.published).toEqual([]);
	});

	test("delivers published content to subscribed listeners", async () => {
		const broadcaster = new TestBroadcaster();
		const listener = vi.fn();
		broadcaster.subscribe("room:1", listener);

		await broadcaster.publish("room:1", { data: "hello" });

		expect(listener).toHaveBeenCalledWith({ data: "hello" });
	});

	test("does not deliver to a listener after unsubscribe", async () => {
		const broadcaster = new TestBroadcaster();
		const listener = vi.fn();
		const unsubscribe = broadcaster.subscribe("room:1", listener);
		unsubscribe();

		await broadcaster.publish("room:1", { data: "hello" });

		expect(listener).not.toHaveBeenCalled();
	});

	test("does not deliver to a listener on a different channel", async () => {
		const broadcaster = new TestBroadcaster();
		const listener = vi.fn();
		broadcaster.subscribe("room:1", listener);

		await broadcaster.publish("room:2", { data: "hello" });

		expect(listener).not.toHaveBeenCalled();
	});

	test("an exception in one listener does not break other listener calls or the publish caller", async () => {
		const broadcaster = new TestBroadcaster();
		const failing = vi.fn(() => {
			throw new Error("boom");
		});
		const succeeding = vi.fn();
		broadcaster.subscribe("room:1", failing);
		broadcaster.subscribe("room:1", succeeding);

		await expect(broadcaster.publish("room:1", { data: "hello" })).resolves.toBeUndefined();

		expect(succeeding).toHaveBeenCalledWith({ data: "hello" });
	});
});
