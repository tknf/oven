/**
 * Health check (liveness) handler.
 *
 * This endpoint only indicates that "the process is up and can respond to requests".
 * It **intentionally** does not check dependencies such as the database. Checking
 * dependencies would let a load balancer/orchestrator restart or evict the app instance
 * itself when a dependency fails, widening the outage — this handler deliberately avoids
 * that failure mode.
 * If a diagnostic that includes dependencies is needed, implement a separate endpoint
 * on the app side.
 *
 * The recommended path is `/up` (a convention, not enforced).
 *
 * @example
 * ```ts
 * app.get("/up", healthCheck);
 * ```
 */
import type { Context } from "hono";

/**
 * `cache-control: no-store` is set so intermediate caches (CDNs, proxies, etc.) do not
 * cache a stale 200 response and misrepresent liveness.
 */
export const healthCheck = (c: Context): Response =>
	c.text("ok", 200, { "cache-control": "no-store" });
