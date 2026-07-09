/**
 * A `ContextAccessor` that injects a DB connection into the context. Like session
 * access (`SessionAccessor`) and auth (`Guard`), this makes DB connection wiring a
 * convention instead of hand-writing custom middleware every time.
 *
 * See `ScopedValueAccessor` (`routing/context_accessor.ts`) for the memoization
 * mechanism behind `scope` itself. Typical usage by scope for DB connections:
 *
 * - `"request"` (default): for runtimes such as Cloudflare Workers that create a
 *   client per request from a `c.env` binding (e.g. D1, Hyperdrive).
 * - `"app"`: for runtimes such as Node that hold a connection pool and want a
 *   single client created once per process (wrapping a drizzle factory function,
 *   e.g. `(c) => drizzle(pool)`).
 */
import type { Env } from "hono";
import { ScopedValueAccessor } from "../routing/context_accessor.js";
import type { ScopedValueAccessorOptions } from "../routing/context_accessor.js";

/**
 * Configuration options for `DatabaseAccessor`.
 */
export type DatabaseAccessorOptions<
	E extends Env,
	K extends keyof E["Variables"] & string,
> = ScopedValueAccessorOptions<E, K>;

/**
 * Injects and memoizes a DB connection in the request context according to `scope`.
 */
export class DatabaseAccessor<
	E extends Env,
	K extends keyof E["Variables"] & string,
> extends ScopedValueAccessor<E, K> {
	protected registerHint(): string {
		return "apply the DatabaseAccessor's register middleware";
	}
}
