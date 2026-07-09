/**
 * Verifies `renderSnippetStream`, the streaming variant of `renderSnippet`. Since JSX literals
 * cannot be used, the tree is built with `hono/jsx`'s `jsx()` function (same approach as
 * `snippet.test.ts`). Checks that reading the response's `ReadableStream` to completion yields
 * the JSX's HTML, for both the default content-type and when `options.contentType` is specified.
 */
import { Hono } from "hono";
import { raw } from "hono/html";
import { jsx } from "hono/jsx";
import { describe, expect, test } from "vite-plus/test";
import { renderSnippetStream } from "../../src/view/streaming.js";

describe("renderSnippetStream", () => {
	test("streams with text/html; charset=UTF-8 by default", async () => {
		const app = new Hono();
		app.get("/", (c) =>
			renderSnippetStream(c, raw(jsx("div", { id: "item" }, "hello").toString())),
		);

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toBe("text/html; charset=UTF-8");
		expect(await res.text()).toBe('<div id="item">hello</div>');
	});

	test("returns with the given content-type when options.contentType is specified", async () => {
		const app = new Hono();
		app.get("/", (c) =>
			renderSnippetStream(c, raw(jsx("div", { id: "item" }, "added").toString()), {
				contentType: "text/vnd.turbo-stream.html; charset=UTF-8",
			}),
		);

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toBe("text/vnd.turbo-stream.html; charset=UTF-8");
		expect(await res.text()).toBe('<div id="item">added</div>');
	});
});
