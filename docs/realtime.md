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
// main.ts
import { Hono } from "hono";
import { broadcastSse } from "@tknf/oven/realtime";
import { broadcaster } from "./lib/broadcaster.js";

const app = new Hono();

app.get("/sse/rooms/:roomId", (c) => {
  const channel = `rooms/${c.req.param("roomId")}`;
  return broadcastSse(c, broadcaster, [channel]);
});

app.post("/rooms/:roomId/messages", async (c) => {
  const roomId = c.req.param("roomId");
  await broadcaster.publish(`rooms/${roomId}`, { data: "<li>a new message</li>", event: "message" });
  return c.body(null, 204);
});

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
app.get("/sse/notifications", (c) =>
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
import type { AppEnv } from "./session.js";

export const channelAuthorizer = new ChannelAuthorizer<AppEnv>({
  "rooms/:roomId": (c, { roomId }) => c.get("account").roomIds.includes(roomId),
});
```

```ts
// main.ts
import { upgradeWebSocket } from "hono/cloudflare-workers";
import { BroadcastWebSocket } from "@tknf/oven/realtime";
import { broadcaster } from "./lib/broadcaster.js";
import { channelAuthorizer } from "./lib/channels.js";

const socket = new BroadcastWebSocket<AppEnv>({
  broadcaster,
  channels: (c) => [`rooms/${c.req.query("roomId")}`],
  authorize: (c) => channelAuthorizer.authorize(c, `rooms/${c.req.query("roomId")}`),
});

app.get("/ws", socket.middleware(upgradeWebSocket));
```

If `authorize` returns `false`, the connection is closed with close code
`1008` (Policy Violation) and `channels` is never subscribed.

**Switching from `InMemoryBroadcaster` to a database-backed adapter.**
`PgDatabaseBroadcaster`/`SQLiteDatabaseBroadcaster`/`MySqlDatabaseBroadcaster`
turn the RDB itself into pub/sub (polling a table for new rows), so
delivery reaches every instance in a multi-process/multi-region deployment
without adding infrastructure. Each ships a matching table factory
(`pgBroadcastsTable`/`sqliteBroadcastsTable`/`mysqlBroadcastsTable`) — run it
through your app's own drizzle-kit migration flow, since oven doesn't
generate migrations for you:

```ts
import { PgDatabaseBroadcaster, pgBroadcastsTable } from "@tknf/oven/realtime";
import { db } from "./lib/db.js";

const broadcastsTable = pgBroadcastsTable();
export const broadcaster = new PgDatabaseBroadcaster(db, broadcastsTable);
```

The `Broadcaster` contract (`publish`/`subscribe`) is identical across all
implementations, so switching backends never touches `broadcastSse` or
`BroadcastWebSocket` call sites — only the constructor in one wiring module.

## Gotchas / Security notes

- **`BroadcastWebSocket` connections are not subject to the Same-Origin
  Policy, and cookies are sent automatically on connection establishment.**
  If `channels` derives its subscription list from the session (e.g. a
  user id), a page on a different origin can open a WebSocket to your
  server and subscribe to that user's channels — Cross-Site WebSocket
  Hijacking. Always perform Origin validation and connection authorization
  in the `authorize` hook, or inside the `channels` callback itself, before
  trusting any session-derived value (this matches the guidance in
  `SECURITY.md`).
- **`InMemoryBroadcaster` only reaches `publish` calls within the same
  process.** It has no cross-instance delivery and no persistence — fine
  for development/tests/single-instance deployments, but silently loses
  messages published from a different instance in a scaled-out deployment.
  Switch to a database-backed (or future Redis/Durable Objects) adapter
  before scaling horizontally.
- **`ScopedValueAccessor` scope matters.** If you wire a `Broadcaster`
  through `ScopedValueAccessor` (`@tknf/oven/routing`) instead of a plain
  module-level singleton, use `scope: "app"`. The default `"request"` scope
  creates a new instance per request, and `InMemoryBroadcaster#publish`
  would then never reach subscribers registered on other requests.
- **SSE connections are held open for as long as the client stays
  connected.** Each one consumes a request/response slot and a listener
  registration; consider a `keepAliveSeconds` value low enough for your
  proxy's idle timeout, and be mindful of how many concurrent SSE
  connections your deployment target (a long-lived Node process vs. a
  Cloudflare Worker's request-scoped execution) can sustain.
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
