/**
 * A thin preset class over `hono/secure-headers`.
 * It doesn't reimplement any header-generation logic — it delegates entirely to Hono's
 * standard `secureHeaders()`.
 *
 * A preset for wiring up the set of headers that should be on by default in a single line.
 * Individual overrides pass through untouched to Hono via `options` (which accepts
 * `secureHeaders()`'s option type as-is).
 *
 * oven's defaults build on Hono's own defaults, strengthening only `xFrameOptions` to
 * `"DENY"` (Hono's own default is `true`, equivalent to `SAMEORIGIN` — confirmed via the
 * JSDoc in `node_modules/hono/dist/types/middleware/secure-headers/secure-headers.d.ts`). If
 * the caller explicitly sets `options.xFrameOptions`, that value always takes precedence.
 */
import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";

/**
 * The option type accepted by `secureHeaders()`. Hono doesn't export a named type for this
 * itself, so it's derived from the first parameter of the function signature (the same
 * technique used for `LayoutComponent` in `layout.ts`).
 */
export type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

export class SecureHeaders {
	/**
	 * An arrow-function class field so it can be passed by reference, e.g.
	 * `app.use(secureHeaders.register)`. The merged options are passed straight through to
	 * `secureHeaders()` (received as a plain constructor argument rather than a constructor
	 * parameter property, since class fields initialize in declaration order and this lets the
	 * constructor argument be used directly).
	 */
	readonly register: MiddlewareHandler;

	constructor(options?: SecureHeadersOptions) {
		this.register = secureHeaders({ xFrameOptions: "DENY", ...options });
	}
}
