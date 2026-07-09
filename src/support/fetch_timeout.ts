/**
 * Shared helper to attach a configurable timeout to outbound `fetch` calls.
 *
 * Cloudflare Workers' `fetch` has no default timeout, so a handler/subrequest
 * can hang against an unresponsive upstream and consume execution
 * time/concurrency slots (this applies to the outbound `fetch` calls in
 * `oauth.ts`, `fetch_mailer.ts`, `s3_storage.ts`, and
 * `upstash_redis_store.ts`). When `timeoutMs` is not specified, this returns
 * `undefined` and behaves as before with no signal (backward compatibility
 * is prioritized).
 */
export const timeoutSignal = (timeoutMs: number | undefined): AbortSignal | undefined =>
	timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
