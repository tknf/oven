/**
 * Verifies `ChannelAuthorizer` (an explicit map from channel name patterns to
 * authorization callbacks). Since the `Context` is passed through to the
 * callback untouched, we use a real `Context` obtained via `Hono`'s
 * `app.request` (same approach as `test/realtime/sse.test.ts` and
 * `web_socket_handler.test.ts`).
 */
import type { Context } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { ChannelAuthorizer } from "../../src/realtime/channel_authorizer.js";

/** Prepares a single real `Context` to pass as the first argument to `authorize`. */
const createContext = async (): Promise<Context> => {
	let captured: Context | undefined;
	const app = new Hono();
	app.get("/dummy", (c) => {
		captured = c;
		return c.body(null);
	});
	await app.request("/dummy");
	if (!captured) throw new Error("Context was not captured");
	return captured;
};

describe("ChannelAuthorizer", () => {
	test("authorizes a pattern with an exact literal match", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/lobby": () => true,
		});

		expect(await authorizer.authorize(c, "rooms/lobby")).toBe(true);
	});

	test("captures :param segments and passes them to the callback", async () => {
		const c = await createContext();
		const received: Record<string, string>[] = [];
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": (_c, params) => {
				received.push(params);
				return true;
			},
		});

		await authorizer.authorize(c, "rooms/42");

		expect(received).toEqual([{ roomId: "42" }]);
	});

	test("correctly captures patterns with multiple :params", async () => {
		const c = await createContext();
		const received: Record<string, string>[] = [];
		const authorizer = new ChannelAuthorizer({
			"users/:userId/notifications": (_c, params) => {
				received.push(params);
				return true;
			},
		});

		await authorizer.authorize(c, "users/7/notifications");

		expect(received).toEqual([{ userId: "7" }]);
	});

	test("only the first rule matched in declaration order is evaluated", async () => {
		const c = await createContext();
		const calledFirst: string[] = [];
		const calledSecond: string[] = [];
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": (_c, params) => {
				calledFirst.push(params.roomId ?? "");
				return true;
			},
			"rooms/42": () => {
				calledSecond.push("called");
				return false;
			},
		});

		const result = await authorizer.authorize(c, "rooms/42");

		expect(result).toBe(true);
		expect(calledFirst).toEqual(["42"]);
		expect(calledSecond).toEqual([]);
	});

	test("returns false for a channel with no matching rule (fail-closed)", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": () => true,
		});

		expect(await authorizer.authorize(c, "unknown/channel")).toBe(false);
	});

	test("returns false for a channel with a different number of segments", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": () => true,
		});

		expect(await authorizer.authorize(c, "rooms/1/extra")).toBe(false);
	});

	test("is not authorized when the callback returns false", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": () => false,
		});

		expect(await authorizer.authorize(c, "rooms/1")).toBe(false);
	});

	test("uses the resolved value when the callback returns a Promise<boolean>", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": async (_c, params) => params.roomId === "1",
		});

		expect(await authorizer.authorize(c, "rooms/1")).toBe(true);
		expect(await authorizer.authorize(c, "rooms/2")).toBe(false);
	});

	test("parameter values are decodeURIComponent'd before being passed", async () => {
		const c = await createContext();
		const received: Record<string, string>[] = [];
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": (_c, params) => {
				received.push(params);
				return true;
			},
		});

		await authorizer.authorize(c, "rooms/room%20a");

		expect(received).toEqual([{ roomId: "room a" }]);
	});

	test("returns false for an invalidly encoded parameter (fail-soft)", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": () => true,
		});

		expect(await authorizer.authorize(c, "rooms/%E0%A4%A")).toBe(false);
	});

	test("returns false for an empty channel string that matches no rule", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({
			"rooms/:roomId": () => true,
		});

		expect(await authorizer.authorize(c, "")).toBe(false);
	});

	test("always returns false for empty rules", async () => {
		const c = await createContext();
		const authorizer = new ChannelAuthorizer({});

		expect(await authorizer.authorize(c, "rooms/1")).toBe(false);
	});

	test("throws in the constructor when a pattern contains *", () => {
		expect(
			() =>
				new ChannelAuthorizer({
					"rooms/*": () => true,
				}),
		).toThrow();
	});
});
