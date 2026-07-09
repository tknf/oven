/**
 * Bundles two HTTP-caching-related features.
 *
 * - `freshWhen`: 304 determination via conditional GET (`ETag`/`Last-Modified`).
 *   The difference from `hono/etag` is
 *   timing — `hono/etag` hashes and compares **after** the response body has
 *   been generated, so it saves bandwidth but not the rendering cost itself.
 *   `freshWhen` determines this **before** the handler starts rendering, so a
 *   304 avoids the rendering cost entirely. It integrates naturally with a
 *   Model's `updatedAt` (epoch ms).
 * - `CacheControl`: a preset class for `Cache-Control` (and optionally
 *   `CDN-Cache-Control`) headers, following the same "settings preset class"
 *   idiom as `secure_headers.ts`.
 */
import type { Context, MiddlewareHandler } from "hono";

export type FreshWhenOptions = {
	etag?: string;
	lastModifiedMs?: number;
};

/**
 * Returns `c.body(null, 304)` if the request is already fresh with respect to
 * `etag`/`lastModifiedMs`. Returns `null` if not fresh (the caller should
 * continue rendering). Usage:
 *
 * ```ts
 * const notModified = freshWhen(c, { lastModifiedMs: book.updatedAt });
 * if (notModified) return notModified;
 * ```
 *
 * Throws as a fail-fast if neither `etag` nor `lastModifiedMs` is specified
 * (guards against a forgotten call). For methods other than GET/HEAD, no
 * determination or header is applied and `null` is returned (conditional
 * requests only make sense for safe methods).
 *
 * Regardless of fresh/stale, `ETag: W/"<etag>"` is set on the response when
 * `etag` is specified, and `Last-Modified` when `lastModifiedMs` is
 * specified. `ETag` is always treated as weak (`W/`) — since SSR HTML output
 * does not guarantee byte-for-byte identity, the semantics of a strong ETag
 * (exact byte match) do not hold.
 *
 * Freshness is determined per RFC 7232, preferring `If-None-Match` over
 * `If-Modified-Since`:
 * - If `If-None-Match` is present and `etag` is specified: `*` always
 *   matches; otherwise each comma-separated value is compared after
 *   stripping the `W/` prefix and quotes, using weak comparison
 * - If `If-None-Match` is absent, `If-Modified-Since` is present, and
 *   `lastModifiedMs` is specified: compared at second precision (since the
 *   HTTP date format has second precision). If the date cannot be parsed, it
 *   is treated as stale (fail-open, letting rendering continue)
 */
export const freshWhen = (c: Context, options: FreshWhenOptions): Response | null => {
	const { etag, lastModifiedMs } = options;
	if (etag === undefined && lastModifiedMs === undefined) {
		throw new Error("freshWhen: specify either etag or lastModifiedMs");
	}

	const method = c.req.method;
	if (method !== "GET" && method !== "HEAD") return null;

	if (etag !== undefined) c.header("ETag", `W/"${etag}"`);
	if (lastModifiedMs !== undefined)
		c.header("Last-Modified", new Date(lastModifiedMs).toUTCString());

	const isFresh = isFreshRequest(c, options);
	return isFresh ? c.body(null, 304) : null;
};

/** Determines freshness, preferring `If-None-Match` over `If-Modified-Since`. */
const isFreshRequest = (c: Context, { etag, lastModifiedMs }: FreshWhenOptions): boolean => {
	const ifNoneMatch = c.req.header("If-None-Match");
	if (ifNoneMatch !== undefined && etag !== undefined) {
		return matchesIfNoneMatch(ifNoneMatch, etag);
	}

	const ifModifiedSince = c.req.header("If-Modified-Since");
	if (ifNoneMatch === undefined && ifModifiedSince !== undefined && lastModifiedMs !== undefined) {
		const since = Date.parse(ifModifiedSince);
		if (Number.isNaN(since)) return false;
		return Math.floor(lastModifiedMs / 1000) <= Math.floor(since / 1000);
	}

	return false;
};

/** Determines whether the `If-None-Match` header value (which may be comma-separated) weakly matches `etag`. */
const matchesIfNoneMatch = (ifNoneMatch: string, etag: string): boolean => {
	if (ifNoneMatch.trim() === "*") return true;

	return ifNoneMatch
		.split(",")
		.map((candidate) =>
			candidate
				.trim()
				.replace(/^W\//, "")
				.replace(/^"(.*)"$/, "$1"),
		)
		.some((candidate) => candidate === etag);
};

export type CacheControlDirectives = {
	public?: boolean;
	private?: boolean;
	noStore?: boolean;
	noCache?: boolean;
	maxAgeSeconds?: number;
	sMaxAgeSeconds?: number;
	staleWhileRevalidateSeconds?: number;
	staleIfErrorSeconds?: number;
	mustRevalidate?: boolean;
	immutable?: boolean;
};

export type CacheControlOptions = {
	directives: CacheControlDirectives;
	/**
	 * When specified, also sets `CDN-Cache-Control` (RFC 9213: Targeted
	 * Cache-Control), useful when you want different cache lifetimes for
	 * browsers (`Cache-Control`) versus a CDN (supported by Cloudflare, etc).
	 */
	cdn?: CacheControlDirectives;
};

/**
 * A preset class that wires up `Cache-Control` (and optionally
 * `CDN-Cache-Control`) headers. In CDN/serverless setups, delegating caching
 * to the edge (CDN) via headers is often more effective than having the
 * origin (this app) hold the cache itself.
 *
 * `use` sets `Cache-Control` only if it is **not already set** on the
 * response after the handler runs (it does not overwrite a value the handler
 * set explicitly). When `cdn` is specified, the same rule applies to
 * `CDN-Cache-Control`.
 */
export class CacheControl {
	readonly value: string;
	readonly cdnValue: string | null;

	/** A class field arrow function, since `app.use(cacheControl.use)` passes it by reference. */
	readonly use: MiddlewareHandler;

	constructor(options: CacheControlOptions) {
		this.value = buildDirectives(options.directives);
		this.cdnValue = options.cdn ? buildDirectives(options.cdn) : null;

		this.use = async (c, next) => {
			await next();
			if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", this.value);
			if (this.cdnValue !== null && !c.res.headers.has("CDN-Cache-Control")) {
				c.header("CDN-Cache-Control", this.cdnValue);
			}
		};
	}
}

/** Validates that `value` is a non-negative integer (shared check for second-based directives). */
const assertNonNegativeInteger = (value: number, name: string): void => {
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(`CacheControl: ${name} must be a non-negative integer (received: ${value})`);
	}
};

/** Validates `CacheControlDirectives` and builds it into a `Cache-Control` header value. */
const buildDirectives = (directives: CacheControlDirectives): string => {
	const {
		public: isPublic,
		private: isPrivate,
		noStore,
		noCache,
		maxAgeSeconds,
		sMaxAgeSeconds,
		staleWhileRevalidateSeconds,
		staleIfErrorSeconds,
		mustRevalidate,
		immutable,
	} = directives;

	const hasAnyDirective = Object.values(directives).some(
		(value) => value !== undefined && value !== false,
	);
	if (!hasAnyDirective) {
		throw new Error(
			"CacheControl: directives is effectively empty (specify at least one directive)",
		);
	}
	if (isPublic && isPrivate) {
		throw new Error("CacheControl: public and private cannot be specified together");
	}
	if (
		noStore &&
		Object.entries(directives).some(
			([key, value]) => key !== "noStore" && value !== undefined && value !== false,
		)
	) {
		throw new Error(
			"CacheControl: noStore can only be specified on its own (cannot be combined with other directives)",
		);
	}
	for (const [name, value] of [
		["maxAgeSeconds", maxAgeSeconds],
		["sMaxAgeSeconds", sMaxAgeSeconds],
		["staleWhileRevalidateSeconds", staleWhileRevalidateSeconds],
		["staleIfErrorSeconds", staleIfErrorSeconds],
	] as const) {
		if (value !== undefined) assertNonNegativeInteger(value, name);
	}

	const parts: string[] = [];
	if (isPublic) parts.push("public");
	if (isPrivate) parts.push("private");
	if (noStore) parts.push("no-store");
	if (noCache) parts.push("no-cache");
	if (maxAgeSeconds !== undefined) parts.push(`max-age=${maxAgeSeconds}`);
	if (sMaxAgeSeconds !== undefined) parts.push(`s-maxage=${sMaxAgeSeconds}`);
	if (staleWhileRevalidateSeconds !== undefined)
		parts.push(`stale-while-revalidate=${staleWhileRevalidateSeconds}`);
	if (staleIfErrorSeconds !== undefined) parts.push(`stale-if-error=${staleIfErrorSeconds}`);
	if (mustRevalidate) parts.push("must-revalidate");
	if (immutable) parts.push("immutable");

	return parts.join(", ");
};
