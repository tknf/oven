# Realtime

## What / Why

`Broadcaster` is oven's pub/sub abstraction for pushing server-initiated
updates to connected clients — a channel name in, a `BroadcastMessage`
(`{ data: string; event?: string }`) out. It deliberately knows nothing
about a specific frontend technology (Turbo Streams, htmx's SSE extension,
plain JSON, etc.): `data` is treated as an opaque, technology-agnostic
string whose interpretation is the caller's contract. Delivery is
at-most-once, best-effort — no retries, no persistence. If you need
guaranteed processing (sending an email, charging a payment), that's a job
for `JobQueue` (`@tknf/oven/jobs`), not `Broadcaster`.

Two transports consume a `Broadcaster` subscription: `broadcastSse` (a
function helper, for Server-Sent Events) and `BroadcastWebSocket` (a
`WebSocketHandler` subclass, for WebSocket). Which channels a connection
subscribes to — and whether it's allowed to — is controlled by the
`channels`/`authorize` options and, for per-channel rules shared across
routes, `ChannelAuthorizer`.

## Minimal example

```ts
// src/lib/broadcaster.ts
import { InMemoryBroadcaster } from "@tknf/oven/realtime";

export const broadcaster = new InMemoryBroadcaster();
```

```ts
// src/domains/rooms/routes.ts
import { Hono } from "hono";
import { broadcastSse } from "@tknf/oven/realtime";
import { broadcaster } from "../../lib/broadcaster.js";

export const roomsRoutes = new Hono()
  .get("/:roomId/events", (c) => {
    const channel = `rooms/${c.req.param("roomId")}`;
    return broadcastSse(c, broadcaster, [channel]);
  })
  .post("/:roomId/messages", async (c) => {
    const roomId = c.req.param("roomId");
    await broadcaster.publish(`rooms/${roomId}`, { data: "<li>a new message</li>", event: "message" });
    return c.body(null, 204);
  });
```

```ts
// src/main.ts
import { Hono } from "hono";
import { roomsRoutes } from "./domains/rooms/routes.js";

const app = new Hono().route("/rooms", roomsRoutes);

export default app;
```

`InMemoryBroadcaster` only delivers within the current process — it's the
right choice for development, tests, and single-instance deployments. See
[Common tasks](#common-tasks) for swapping in a multi-instance backend.

## Common tasks

**Publishing from a handler.** `publish` never throws even if there are no
subscribers, so it's safe to call unconditionally after a write:

```ts
await broadcaster.publish("rooms/1", { data: renderedHtml, event: "message" });
```

**Exposing an SSE endpoint.** `broadcastSse` subscribes to every channel in
the array you pass, converts each `BroadcastMessage` into an SSE event, and
unsubscribes from all of them on disconnect (detected via
`SSEStreamingApi.onAbort`), so there's nothing to clean up manually:

```ts
export const notificationsRoutes = new Hono().get("/events", (c) =>
  broadcastSse(c, broadcaster, ["users/1/notifications"], { keepAliveSeconds: 30 }),
);
```

`keepAliveSeconds`, when set, writes an SSE comment line (`: keep-alive`) on
that interval so proxies don't close an otherwise-idle connection.

**Accepting a WebSocket connection with per-channel authorization.**
`BroadcastWebSocket` is a `WebSocketHandler` that wires `onOpen`/`onClose`/
`onError` to `Broadcaster#subscribe`/unsubscribe for you. Combine it with
`ChannelAuthorizer` when channel access depends on the connecting user:

```ts
// src/lib/channels.ts
import { ChannelAuthorizer } from "@tknf/oven/realtime";
import type { AppEnv } from "../env.js";

export const channelAuthorizer = new ChannelAuthorizer<AppEnv>({
  "rooms/:roomId": (c, { roomId }) => c.get("account").roomIds.includes(roomId),
});
```

```ts
// src/domains/rooms/socket_routes.ts
import { Hono } from "hono";
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { BroadcastWebSocket } from "@tknf/oven/realtime";
import type { AppEnv } from "../../env.js";
import { broadcaster } from "../../lib/broadcaster.js";
import { channelAuthorizer } from "../../lib/channels.js";

const socket = new BroadcastWebSocket<AppEnv>({
  broadcaster,
  channels: (c) => [`rooms/${c.req.query("roomId")}`],
  authorize: (c) => channelAuthorizer.authorize(c, `rooms/${c.req.query("roomId")}`),
});

export const roomSocketRoutes = new Hono<AppEnv>().get("/ws", socket.middleware(upgradeWebSocket));
```

If `authorize` returns `false`, the connection is closed with close code
`1008` (Policy Violation) and `channels` is never subscribed.

**Switching from `InMemoryBroadcaster` to a database-backed adapter.**
`PgDatabaseBroadcaster`/`SQLiteDatabaseBroadcaster`/`MySqlDatabaseBroadcaster`
turn the RDB itself into pub/sub (polling a table for new rows), so
delivery reaches every instance in a multi-process/multi-region deployment
without adding infrastructure. Each ships a matching table factory
(`pgBroadcastsTable`/`sqliteBroadcastsTable`/`mysqlBroadcastsTable`). Export
the table from a schema module that `src/db/schema.ts` re-exports, so
drizzle-kit generates its migration through your app's own scripts (oven
doesn't generate migrations for you):

```ts
// src/domains/realtime/schema.ts
import { pgBroadcastsTable } from "@tknf/oven/realtime";

export const broadcasts = pgBroadcastsTable();
```

```ts
// src/lib/broadcaster.ts
import { PgDatabaseBroadcaster } from "@tknf/oven/realtime";
import { db } from "../db/client.js"; // a Drizzle db built once for the process
import { broadcasts } from "../domains/realtime/schema.js";

export const broadcaster = new PgDatabaseBroadcaster(db, broadcasts);
```

The `Broadcaster` contract (`publish`/`subscribe`) is identical across all
implementations, so switching backends never touches `broadcastSse` or
`BroadcastWebSocket` call sites — only the constructor in one wiring module.

**Switching from `InMemoryBroadcaster` to `DurableObjectBroadcaster` on
Cloudflare Workers.** `DurableObjectBroadcaster` (`@tknf/oven/cloudflare`)
turns a Durable Object into the channel's coordination point instead of a
table: one DO instance per channel (`namespace.idFromName(channel)`) fans a
published message out to every WebSocket it currently holds. oven does not
write your `wrangler.jsonc` for you — re-export the DO class from your
Worker's entry point and declare the binding and migration yourself:

```ts
// src/worker.ts
export { BroadcasterDurableObject } from "@tknf/oven/cloudflare";
```

```jsonc
// wrangler.jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "BROADCASTER", "class_name": "BroadcasterDurableObject" }],
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["BroadcasterDurableObject"] }],
}
```

```ts
// src/lib/broadcaster.ts
import { DurableObjectBroadcaster } from "@tknf/oven/cloudflare";

export const makeBroadcaster = (namespace: DurableObjectNamespace) =>
  new DurableObjectBroadcaster(namespace, {
    onListenerError: (error, channel) => console.error(`listener failed on ${channel}`, error),
    onDisconnect: (attempt, error, channel) => console.warn(`reconnecting ${channel}`, attempt, error),
    onReconnect: (attempt, channel) => console.info(`reconnected ${channel}`, attempt),
  });
```

One thing makes this adapter's timing different from the others: `subscribe`
returns before the WebSocket to the DO finishes connecting, so a `publish`
that lands in that short window is not delivered to that listener (the
DB-backed adapters have the same kind of gap from polling; `InMemoryBroadcaster`
does not). This is fine for the request-scoped `broadcastSse`/`BroadcastWebSocket`
connections shown above, since their own client already handles reconnecting
from scratch.

**If the WebSocket to the DO closes for any reason** (the DO instance
erroring, an infrastructure hiccup, etc.), this adapter automatically retries
the connection with exponential backoff (`reconnectInitialDelayMs`, doubling
up to `reconnectMaxDelayMs`) until it succeeds or you call the `subscribe`
return value to unsubscribe — set `reconnect: false` to leave the
subscription closed once its socket closes.
Reconnecting only restores the subscription's liveness, not what was missed:
a `publish` that lands while the socket is down (or reconnecting) is never
redelivered, same as any other gap covered by the `Broadcaster` base
contract's at-most-once guarantee. `onDisconnect`/`onReconnect` are
observability hooks only (logging, metrics) — there is nothing to act on
beyond that, since the adapter already retries on its own.

## Gotchas / Security notes

- **`BroadcastWebSocket` performs no Origin check itself.** If `channels`
  derives its subscription list from the session (e.g. a user id), perform
  Origin validation and connection authorization in the `authorize` hook, or
  inside the `channels` callback itself, before trusting any session-derived
  value, to prevent Cross-Site WebSocket Hijacking (this matches the guidance
  in `SECURITY.md`).
- **`InMemoryBroadcaster` only reaches `publish` calls within the same
  process.** It has no cross-instance delivery and no persistence — fine
  for development/tests/single-instance deployments, but silently loses
  messages published from a different instance in a scaled-out deployment.
  Switch to a database-backed adapter or, on Cloudflare Workers,
  `DurableObjectBroadcaster` before scaling horizontally.
- **`ScopedValueAccessor` scope matters.** If you wire a `Broadcaster`
  through `ScopedValueAccessor` (`@tknf/oven/routing`) instead of a plain
  module-level singleton, use `scope: "app"`. The default `"request"` scope
  creates a new instance per request, and `InMemoryBroadcaster#publish`
  would then never reach subscribers registered on other requests.
- **Set `keepAliveSeconds` below your proxy's idle timeout.** Each open
  `broadcastSse` connection holds one listener registration until the client
  disconnects.
- **`ChannelAuthorizer` fails closed.** A channel name that matches no
  registered pattern is never implicitly allowed — `authorize` returns
  `false`. Wildcards (`*`) in a pattern throw at construction time instead
  of matching silently, so a typo'd rule fails fast rather than
  over-authorizing.

## See also

- [Concepts](./concepts.md) — the `register`/`use` convention referenced
  above (`ScopedValueAccessor`), and oven's backend-agnostic principle that
  `Broadcaster` follows.
- [Sessions](./sessions.md) — the session-derived identity typically used
  inside `channels`/`authorize` callbacks.
- [Jobs](./jobs.md) — the queue abstraction to reach for when you need
  guaranteed (rather than best-effort) delivery.
