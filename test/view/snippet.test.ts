/**
 * Verifies `renderSnippet`, a general-purpose helper that returns a JSX fragment without going
 * through a layout. Since JSX literals cannot be used, the tree is built with `hono/jsx`'s
 * `jsx()` function (same approach as `view_helpers.test.ts`). Checks both the default
 * content-type and the case where `options.contentType` is specified.
 */
import { Hono } from "hono";
import { raw } from "hono/html";
import { jsx } from "hono/jsx";
import { describe, expect, test } from "vite-plus/test";
import { renderSnippet } from "../../src/view/snippet.js";

describe("renderSnippet", () => {
	test("returns the fragment with text/html; charset=UTF-8 by default", async () => {
		const app = new Hono();
		app.get("/", (c) => renderSnippet(c, raw(jsx("div", { id: "item" }, "hello").toString())));

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
		expect(await res.text()).toBe('<div id="item">hello</div>');
	});

	test("returns with the given content-type when options.contentType is specified", async () => {
		const app = new Hono();
		app.get("/", (c) =>
			renderSnippet(c, raw(jsx("turbo-stream", { action: "append" }, "added").toString()), {
				contentType: "text/vnd.turbo-stream.html; charset=UTF-8",
			}),
		);

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toBe("text/vnd.turbo-stream.html; charset=UTF-8");
		expect(await res.text()).toBe('<turbo-stream action="append">added</turbo-stream>');
	});
});
