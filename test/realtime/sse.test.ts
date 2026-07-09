/**
 * Verifies `broadcastSse` (a function helper that connects a `Broadcaster`
 * subscription to an SSE response). Reads the response's `ReadableStream`
 * obtained via `app.request` with a reader, and checks that published
 * content flows in SSE format (`event:` / `data:`) and that the Content-Type
 * is `text/event-stream`. Unsubscribing on abort itself is omitted since it
 * is difficult to test.
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { broadcastSse } from "../../src/realtime/sse.js";
import { InMemoryBroadcaster } from "../../src/realtime/in_memory_broadcaster.js";

describe("broadcastSse", () => {
	test("sets Content-Type to text/event-stream", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const app = new Hono();
		app.get("/sse", (c) => broadcastSse(c, broadcaster, ["room:1"]));

		const res = await app.request("/sse");

		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		await res.body?.cancel();
	});

	test("publish to a subscribed channel can be read from the reader in SSE format", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const app = new Hono();
		app.get("/sse", (c) => broadcastSse(c, broadcaster, ["room:1"]));

		const res = await app.request("/sse");
		const reader = res.body?.getReader();
		if (!reader) throw new Error("response body is not readable");

		await broadcaster.publish("room:1", { data: "hello", event: "message" });
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		expect(text).toBe("event: message\ndata: hello\n\n");

		await reader.cancel();
	});

	test("can subscribe to multiple channels and publish to an unsubscribed channel is not delivered", async () => {
		const broadcaster = new InMemoryBroadcaster();
		const app = new Hono();
		app.get("/sse", (c) => broadcastSse(c, broadcaster, ["room:1", "room:2"]));

		const res = await app.request("/sse");
		const reader = res.body?.getReader();
		if (!reader) throw new Error("response body is not readable");

		await broadcaster.publish("room:other", { data: "ignored" });
		await broadcaster.publish("room:2", { data: "hello" });
		const { value } = await reader.read();
		const text = new TextDecoder().decode(value);

		expect(text).toBe("data: hello\n\n");

		await reader.cancel();
	});
});
