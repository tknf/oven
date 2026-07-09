/**
 * Function helper that connects `Broadcaster` channel subscriptions to
 * `hono/streaming`'s `streamSSE`, returning them as a Server-Sent Events
 * response. Converts each `BroadcastMessage` into an SSE event (`data`, and an
 * `event` field if `event` is set) and writes it.
 *
 * On disconnection (client disconnect, timeout-triggered abort, etc.), it is
 * detected via `SSEStreamingApi.onAbort`, and every subscribed channel is
 * always unsubscribed (to prevent leaks). If `keepAliveSeconds` is specified,
 * an SSE comment line (`: keep-alive`) is emitted at that interval to prevent
 * proxies from closing idle connections. The keep-alive timer is also always
 * cleared on abort.
 */
import type { Context, Env } from "hono";
import { streamSSE } from "hono/streaming";
import type { Broadcaster } from "./broadcaster.js";

export const broadcastSse = <E extends Env>(
	c: Context<E>,
	broadcaster: Broadcaster,
	channels: string[],
	options?: { keepAliveSeconds?: number },
): Response =>
	streamSSE(c, async (stream) => {
		const unsubscribes = channels.map((channel) =>
			broadcaster.subscribe(channel, (message) => {
				void stream.writeSSE({ data: message.data, event: message.event });
			}),
		);

		const keepAliveTimer =
			options?.keepAliveSeconds === undefined
				? undefined
				: setInterval(() => {
						void stream.write(": keep-alive\n\n");
					}, options.keepAliveSeconds * 1000);

		await new Promise<void>((resolve) => {
			stream.onAbort(() => {
				if (keepAliveTimer !== undefined) clearInterval(keepAliveTimer);
				for (const unsubscribe of unsubscribes) unsubscribe();
				resolve();
			});
		});
	});
