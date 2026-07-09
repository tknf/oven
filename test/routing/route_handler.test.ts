/**
 * Tests for `RouteHandler` (the abstract base for wiring conventions built on
 * Hono inheritance).
 *
 * jsxRenderer integration is verified with a minimal layout built using only
 * `hono/html`'s `raw`, without depending on JSX syntax (.tsx). Vitest only
 * targets `test/**\/*.test.ts`, so `.tsx` test files are not run.
 *
 * The type of `c.render(content, props)`'s second argument depends on Hono's
 * `ContextRenderer` module augmentation (see the JSDoc in `layout.ts`). The
 * app itself (`src/env.ts`) already declares this augmentation, but to avoid
 * implicitly relying on the app's global declaration for `src/` tests, this
 * test file declares the same augmentation itself (exactly the intended
 * usage example for `LayoutProps`).
 */
import type { Env, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { raw } from "hono/html";
import { describe, expect, test } from "vite-plus/test";
import type { LayoutComponent, LayoutProps } from "../../src/view/layout.js";
import { RouteHandler } from "../../src/routing/route_handler.js";

declare module "hono" {
	interface ContextRenderer {
		(content: string | Promise<string>, props: LayoutProps): Response | Promise<Response>;
	}
}

/**
 * A minimal test-only layout. Returns plain HTML embedding `title`/`children`.
 * Since `children` (the `Child` type) is always passed as a string in this
 * test, it is only interpolated in that case (`Child` can also be an array,
 * a JSXNode, etc., and unconditional interpolation could stringify to
 * `[object Object]`).
 */
const testLayout: LayoutComponent = ({ title, children }) => {
	const body = typeof children === "string" ? children : "";
	return raw(`<html><head><title>${title}</title></head><body>${body}</body></html>`);
};

describe("RouteHandler", () => {
	test("a route declared in register() works via app.route()", async () => {
		class BooksHandler extends RouteHandler {
			protected register() {
				this.get("/", (c) => c.text("books-index"));
			}
		}

		const app = new Hono();
		app.route("/books", new BooksHandler());

		const res = await app.request("/books");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("books-index");
	});

	test("returning layout() applies jsxRenderer and c.render renders through the layout", async () => {
		class PagesHandler extends RouteHandler {
			protected layout() {
				return testLayout;
			}
			protected register() {
				this.get("/", (c) => c.render("<p>hello</p>", { title: "Test Page" }));
			}
		}

		const app = new Hono();
		app.route("/pages", new PagesHandler());

		const res = await app.request("/pages");
		const body = await res.text();

		expect(body).toContain("<title>Test Page</title>");
		expect(body).toContain("<p>hello</p>");
	});

	test("middleware() is applied in declaration order", async () => {
		const order: string[] = [];
		type OrderEnv = Env & { Variables: { order?: string[] } };

		const first: MiddlewareHandler<OrderEnv> = async (_c, next) => {
			order.push("first");
			await next();
		};
		const second: MiddlewareHandler<OrderEnv> = async (_c, next) => {
			order.push("second");
			await next();
		};

		class OrderedHandler extends RouteHandler<OrderEnv> {
			protected middleware() {
				return [first, second];
			}
			protected register() {
				this.get("/", (c) => c.text("ok"));
			}
		}

		const app = new Hono<OrderEnv>();
		app.route("/ordered", new OrderedHandler());

		await app.request("/ordered");

		expect(order).toEqual(["first", "second"]);
	});

	test("can inherit layout/middleware from an intermediate base and compose with super.middleware()", async () => {
		const order: string[] = [];
		type OrderEnv = Env & { Variables: { order?: string[] } };

		const baseMw: MiddlewareHandler<OrderEnv> = async (_c, next) => {
			order.push("base");
			await next();
		};
		const childMw: MiddlewareHandler<OrderEnv> = async (_c, next) => {
			order.push("child");
			await next();
		};

		abstract class NamespaceHandler extends RouteHandler<OrderEnv> {
			protected layout() {
				return testLayout;
			}
			protected middleware() {
				return [baseMw];
			}
		}

		class LeafHandler extends NamespaceHandler {
			protected middleware() {
				return [...super.middleware(), childMw];
			}
			protected register() {
				this.get("/", (c) => c.render("<p>leaf</p>", { title: "Leaf" }));
			}
		}

		const app = new Hono<OrderEnv>();
		app.route("/leaf", new LeafHandler());

		const res = await app.request("/leaf");

		expect(order).toEqual(["base", "child"]);
		expect(await res.text()).toContain("<title>Leaf</title>");
	});

	test("returns a plain Response with no renderer when layout() is null (default)", async () => {
		class PlainHandler extends RouteHandler {
			protected register() {
				this.get("/", (c) => c.text("plain"));
			}
		}

		const app = new Hono();
		app.route("/plain", new PlainHandler());

		const res = await app.request("/plain");

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("plain");
	});

	describe("resources()", () => {
		test("all 7 routes respond at the expected METHOD x path when all actions are specified", async () => {
			class BooksHandler extends RouteHandler {
				protected register() {
					this.resources({
						index: (c) => c.text("index"),
						new: (c) => c.text("new"),
						create: (c) => c.text("create"),
						show: (c) => c.text(`show:${c.req.param("id")}`),
						edit: (c) => c.text(`edit:${c.req.param("id")}`),
						update: (c) => c.text(`update:${c.req.param("id")}`),
						destroy: (c) => c.text(`destroy:${c.req.param("id")}`),
					});
				}
			}

			const app = new Hono();
			app.route("/books", new BooksHandler());

			expect(await (await app.request("/books")).text()).toBe("index");
			expect(await (await app.request("/books/new")).text()).toBe("new");
			expect(await (await app.request("/books", { method: "POST" })).text()).toBe("create");
			expect(await (await app.request("/books/1")).text()).toBe("show:1");
			expect(await (await app.request("/books/1/edit")).text()).toBe("edit:1");
			expect(await (await app.request("/books/1", { method: "PATCH" })).text()).toBe("update:1");
			expect(await (await app.request("/books/1", { method: "PUT" })).text()).toBe("update:1");
			expect(await (await app.request("/books/1", { method: "DELETE" })).text()).toBe("destroy:1");
		});

		test("an unspecified route results in 404 when only some actions are specified", async () => {
			class BooksHandler extends RouteHandler {
				protected register() {
					this.resources({
						index: (c) => c.text("index"),
						show: (c) => c.text(`show:${c.req.param("id")}`),
					});
				}
			}

			const app = new Hono();
			app.route("/books", new BooksHandler());

			expect((await app.request("/books")).status).toBe(200);
			expect((await app.request("/books/1")).status).toBe(200);
			// When `new` is not specified, `/books/new` is received by show (`/:id`)
			// with `id="new"` (natural Hono routing behavior, not a bug in resources).
			expect((await app.request("/books/1/edit")).status).toBe(404);
			expect((await app.request("/books", { method: "POST" })).status).toBe(404);
			expect((await app.request("/books/1", { method: "DELETE" })).status).toBe(404);
		});

		test("/new is not swallowed by show (/:id) and the new registration takes priority", async () => {
			class BooksHandler extends RouteHandler {
				protected register() {
					this.resources({
						new: (c) => c.text("new-form"),
						show: (c) => c.text(`show:${c.req.param("id")}`),
					});
				}
			}

			const app = new Hono();
			app.route("/books", new BooksHandler());

			const res = await app.request("/books/new");

			expect(await res.text()).toBe("new-form");
		});

		test("listing, new form, and show work when mounted at a base path", async () => {
			class BooksHandler extends RouteHandler {
				protected register() {
					this.resources({
						index: (c) => c.text("index"),
						new: (c) => c.text("new"),
						show: (c) => c.text(`show:${c.req.param("id")}`),
					});
				}
			}

			const app = new Hono();
			app.route("/books", new BooksHandler());

			expect(await (await app.request("/books")).text()).toBe("index");
			expect(await (await app.request("/books/new")).text()).toBe("new");
			expect(await (await app.request("/books/42")).text()).toBe("show:42");
		});
	});
});
