/**
 * Generic helper that returns a JSX fragment as a standalone `Response`
 * without going through a layout (`jsxRenderer`). Intended for returning
 * fragments to partial-update frontends (htmx / Turbo Streams, etc.).
 * Pass `options.contentType` for technologies that need a dedicated
 * content-type.
 *
 * `element` accepts hono/jsx's `JSX.Element` type
 * (`HtmlEscapedString | Promise<HtmlEscapedString>`; see
 * `node_modules/hono/dist/types/jsx/base.d.ts`). Since `HtmlEscapedString` is
 * a boxed String object created by `raw()` via `new String(value)` (see the
 * JSDoc in `mail_template.ts`), it must always be converted to a primitive
 * string via `.toString()` after `await` before being passed as the response
 * body.
 */
import type { Context, Env } from "hono";
import type { JSX } from "hono/jsx/jsx-runtime";

const DEFAULT_CONTENT_TYPE = "text/html; charset=UTF-8";

/** Shared logic that evaluates `element` and converts the boxed String result to a primitive string body. */
const renderBody = async (element: JSX.Element): Promise<string> => (await element).toString();

/**
 * Returns `element` as `text/html` (default). Can be overridden via
 * `options.contentType`.
 */
export const renderSnippet = async <E extends Env>(
	c: Context<E>,
	element: JSX.Element,
	options?: { contentType?: string },
): Promise<Response> => {
	const body = await renderBody(element);
	return c.body(body, 200, { "Content-Type": options?.contentType ?? DEFAULT_CONTENT_TYPE });
};
