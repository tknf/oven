/**
 * Streaming version of `renderSnippet` (`src/view/snippet.ts`). Converts a
 * `JSX.Element` into a `ReadableStream` via `hono/jsx/streaming`'s
 * `renderToReadableStream` and returns it as a `Response`. The main use case
 * is progressive rendering combined with `Suspense` (starting the response
 * without waiting for an async component to resolve while a fallback is shown).
 *
 * Constraint: headers cannot be changed once streaming has started (after
 * response headers are sent), so this is incompatible with automatic session
 * commit (`SessionAccessor`) (the same constraint as `stream: true`). Routes
 * that use streaming must finish writing to the session before `element` is
 * evaluated.
 */
import type { Context, Env } from "hono";
import { renderToReadableStream } from "hono/jsx/streaming";
import type { JSX } from "hono/jsx/jsx-runtime";

const DEFAULT_CONTENT_TYPE = "text/html; charset=UTF-8";

/**
 * Streams `element` as `text/html` (default). Can be overridden via
 * `options.contentType`.
 */
export const renderSnippetStream = <E extends Env>(
	c: Context<E>,
	element: JSX.Element,
	options?: { contentType?: string },
): Response => {
	const body = renderToReadableStream(element);
	return c.body(body, 200, { "Content-Type": options?.contentType ?? DEFAULT_CONTENT_TYPE });
};
