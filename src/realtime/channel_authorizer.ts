/**
 * Expresses per-channel authorization for realtime delivery (SSE/WebSocket) as an
 * explicit "channel name pattern to authorization callback" table. This is a
 * minimal channel-authorization layer.
 *
 * **Separation of concerns**: authentication ("who is this") remains the
 * responsibility of `Guard` (resolves a principal from the session, etc. and
 * returns a failure response), while this class only handles per-channel
 * authorization ("may this principal subscribe to this channel"). The two are
 * meant to be combined; this class itself does not deal with sessions or
 * principal resolution (it passes the `Context` straight through to the
 * `authorize` callback and leaves the decision to the caller).
 *
 * Pattern syntax uses Hono-style path `:param` segments (e.g. `"rooms/:roomId"`),
 * separated by `/`. Wildcard `*` is not supported, because it makes it hard to
 * tell at a glance which rule in the table a channel matches; it is detected and
 * throws in the constructor (fail-fast). Only the first rule that matches in
 * declaration order is evaluated, and a channel that matches no pattern
 * **fail-closes to false** (a channel not in the table is never silently allowed).
 *
 * ```ts
 * const authorizer = new ChannelAuthorizer<Env>({
 *   "rooms/:roomId": (c, { roomId }) => c.get("account").roomIds.includes(roomId),
 *   "users/:userId/notifications": (c, { userId }) => c.get("account").id === userId,
 * });
 *
 * app.get("/sse/rooms/:roomId", async (c) => {
 *   const channel = `rooms/${c.req.param("roomId")}`;
 *   if (!(await authorizer.authorize(c, channel))) return c.body(null, 403);
 *   return broadcastSse(c, broadcaster, [channel]);
 * });
 * ```
 */
import type { Context, Env } from "hono";

/** Authorization callback. Receives the matched path parameters and returns whether subscription is allowed. */
export type ChannelAuthorizeFn<E extends Env> = (
	c: Context<E>,
	params: Record<string, string>,
) => boolean | Promise<boolean>;

type CompiledRule<E extends Env> = {
	segments: string[];
	authorize: ChannelAuthorizeFn<E>;
};

export class ChannelAuthorizer<E extends Env> {
	private readonly rules: CompiledRule<E>[];

	constructor(rules: Record<string, ChannelAuthorizeFn<E>>) {
		this.rules = Object.entries(rules).map(([pattern, authorize]) => {
			if (pattern.includes("*")) {
				throw new Error(`ChannelAuthorizer: wildcard "*" is not supported (pattern: "${pattern}")`);
			}
			return { segments: pattern.split("/"), authorize };
		});
	}

	/**
	 * Matches a channel name against the table to decide authorization. Only the
	 * first rule that matches, in declaration order, is evaluated; if no rule
	 * matches, returns false (fail-closed). Kept as an arrow function class field
	 * since it may be passed by reference.
	 */
	readonly authorize = async (c: Context<E>, channel: string): Promise<boolean> => {
		const channelSegments = channel.split("/");

		for (const rule of this.rules) {
			if (rule.segments.length !== channelSegments.length) continue;

			const params: Record<string, string> = {};
			let matched = true;

			for (const [index, segment] of rule.segments.entries()) {
				const value = channelSegments[index];
				if (value === undefined) {
					matched = false;
					break;
				}

				if (segment.startsWith(":")) {
					try {
						params[segment.slice(1)] = decodeURIComponent(value);
					} catch {
						return false;
					}
					continue;
				}

				if (segment !== value) {
					matched = false;
					break;
				}
			}

			if (matched) return rule.authorize(c, params);
		}

		return false;
	};
}
