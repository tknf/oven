/**
 * Fragment cache helper that stores the rendered result (HTML string) of a JSX
 * fragment in a `Cache` and skips re-rendering on a hit (a minimal form of
 * nested fragment caching).
 *
 * **Safety assumption**: what gets stored in the cache is an HTML string that
 * was already escaped at the time `render()` produced it as JSX. Returning it
 * as-is via `raw()` on retrieval only means "the already-rendered HTML is not
 * re-escaped" — it does not introduce a new XSS surface. This safety relies on
 * the operational assumption that "no non-HTML string bypassing this helper is
 * ever written into the same key space (the same `prefix` of the `Cache`)"
 * (since `raw()` unconditionally treats the passed string as already escaped,
 * any unescaped externally-sourced string that slips in becomes XSS as-is).
 *
 * **Key design is the app's responsibility**: this helper has no active
 * invalidation API (like the existing `Cache` contract, only TTL expiry or
 * `Cache#forget`). Invalidation is expressed as a "key change" by including
 * the target data's update timestamp or version in the key (e.g.
 * `` `fragment:book-${book.id}-${book.updatedAt}` ``).
 *
 * **Fragments that must not be cached**: fragments containing `Suspense` or
 * depending on `useRequestContext` must not be cached. The former holds
 * mid-streaming state and cannot be stringified; the latter depends on
 * per-request context (e.g. the logged-in user), so caching it would leak HTML
 * across different users.
 */
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { JSX } from "hono/jsx/jsx-runtime";
import type { Cache } from "../cache/cache.js";

export type CacheFragmentOptions = {
	/** Fragment retention period, in seconds. */
	ttlSeconds: number;
};

/**
 * Returns the cached HTML for `key` via `raw()` if present; otherwise runs
 * `render()`, stringifies the resulting HTML, stores it, and returns it.
 */
export const cacheFragment = async (
	cache: Cache,
	key: string,
	options: CacheFragmentOptions,
	render: () => JSX.Element | Promise<JSX.Element>,
): Promise<HtmlEscapedString> => {
	const html = await cache.remember<string>(key, options.ttlSeconds, async () => {
		const element = await render();
		return element.toString();
	});
	return raw(html);
};
