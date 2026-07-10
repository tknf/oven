/**
 * Abstract base class implementing a wiring convention on top of `Hono` (verified
 * against a real spike — Hono 4.12.27). `app.route("/admin/books", new BooksHandler())`
 * works as-is (Hono itself documents "use it by subclassing" as an intended pattern,
 * the same pattern used by presets such as `hono/quick`).
 *
 * Wiring order is fixed: `layout()` → `middleware()` → `register()`. Middleware
 * returned by `middleware()` runs after the renderer from `layout()` is applied
 * (allowing subsequent middleware to be written assuming the renderer's `c.render`
 * is available).
 *
 * Intended usage: the app defines per-namespace intermediate base classes (e.g.
 * `AdminHandler` providing `layout()`/`middleware()`), and individual handlers (e.g.
 * `BooksHandler`) only need to write `register()`. `main.ts` then contains only the
 * mounting line (`app.route("/admin/books", new BooksHandler())`), structurally
 * preventing handler logic from leaking into `main.ts`.
 *
 * **Constraints confirmed by the spike (must be observed):**
 *
 * 1. **Reserved names**: names that Hono itself uses as instance fields/methods
 *    (`get`, `post`, `put`, `delete`, `options`, `patch`, `all`, `on`, `use`, `router`,
 *    `getPath`, `routes`, `fetch`, `request`, `route`, `basePath`, `mount`, `notFound`,
 *    `onError`, etc.) must not be used as subclass hook or field names. In particular,
 *    `routes` is held by Hono as its route registry field (`routes = []`), and at the
 *    time `super()` runs it shadows a subclass prototype method of the same name,
 *    causing `this.routes is not a function` (confirmed on a real run).
 * 2. **Hooks must be written as methods/getters (not class fields)**. Because wiring
 *    runs inside the base constructor, subclass field initialization (which happens
 *    after `super()`) is too late. Writing `layout = AdminLayout` as a class field
 *    results in `undefined` (confirmed on a real run). Write it as a method instead,
 *    e.g. `protected layout() { return AdminLayout; }`.
 * 3. The RPC type chain (the `hc` client) is lost with the class-based approach, but
 *    this does not matter for an SSR-only stack (Turbo/Stimulus).
 * 4. **Mounting at the app root leaks `layout()`/`middleware()` to the whole app.**
 *    A path-less `this.use(...)` (which is what `layout()` and `middleware()`
 *    compile down to in the constructor) registers under Hono's internal `"*"`
 *    path. When the handler is mounted with `app.route(path, handler)`, Hono's
 *    `mergePath(path, "*")` lifts that registration onto the parent app. For any
 *    non-root `path` (e.g. `"/admin"`) this merges to `"/admin/*"`, correctly
 *    scoped — but for `app.route("/", handler)` it merges to `"/*"`, which is
 *    every route on the parent app, not just this handler's own routes
 *    (confirmed on a real run against Hono 4.12.27). Avoid this either by (a)
 *    mounting the handler on a dedicated base path instead of `"/"`, or, if it
 *    must be mounted at the root, by (b) leaving `layout()` unset (`null`) and
 *    applying `jsxRenderer` per route inside `register()` instead, and (c) doing
 *    the same for `middleware()` — apply it per route rather than overriding the
 *    hook.
 */
import type { Env, Handler, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { jsxRenderer } from "hono/jsx-renderer";
import type { LayoutComponent } from "../view/layout.js";

/**
 * The set of RESTful actions accepted by `RouteHandler#resources`. Only the routes for
 * the keys you supply are created (unspecified actions are not registered).
 *
 * | Action     | METHOD                  | Path        |
 * | ---------- | ---------------------- | ----------- |
 * | `index`    | GET                     | `/`         |
 * | `new`      | GET                     | `/new`      |
 * | `create`   | POST                    | `/`         |
 * | `show`     | GET                     | `/:id`      |
 * | `edit`     | GET                     | `/:id/edit` |
 * | `update`   | PATCH, PUT              | `/:id`      |
 * | `destroy`  | DELETE                  | `/:id`      |
 */
export type ResourceActions<E extends Env> = {
	/** GET / — index/listing */
	index?: Handler<E>;
	/** GET /new — new-record form */
	new?: Handler<E>;
	/** POST / — create */
	create?: Handler<E>;
	/** GET /:id — show */
	show?: Handler<E>;
	/** GET /:id/edit — edit form */
	edit?: Handler<E>;
	/** PATCH /:id and PUT /:id — update */
	update?: Handler<E>;
	/** DELETE /:id — destroy */
	destroy?: Handler<E>;
};

export abstract class RouteHandler<E extends Env = Env> extends Hono<E> {
	/**
	 * The layout applied to this handler. Defaults to `null` (no renderer applied).
	 * Overrides must be written as a method (not a class field — see constraint 2).
	 */
	protected layout(): LayoutComponent | null {
		return null;
	}

	/**
	 * Additional middleware applied to this handler. Runs, in the array's declared
	 * order, after the renderer from `layout()` is applied and before the routes from
	 * `register()` are registered. Overrides must be written as a method (not a class
	 * field — see constraint 2).
	 */
	protected middleware(): MiddlewareHandler<E>[] {
		return [];
	}

	/** Registers routes. Subclasses write plain Hono code here (`this.get(...)`, etc.). */
	protected abstract register(): void;

	/**
	 * Registers a batch of RESTful resource routes. This is an API that the app calls
	 * explicitly from within `register()`; there is no auto-discovery or implicit
	 * registration by convention (only the actions specified in `ResourceActions` get a
	 * route).
	 *
	 * Registration order is fixed (`index` → `new` → `create` → `show` → `edit` →
	 * `update` → `destroy`). The static path (`/new`) is always registered before the
	 * parameterized path (`/:id`), so `/new` is not swallowed by `show` (`/:id`).
	 *
	 * This helper does not hide anything if you need to insert middleware — the app can
	 * simply write `this.use("/:id", mw)` as usual inside `register()`.
	 *
	 * @example
	 * ```ts
	 * class BooksHandler extends RouteHandler {
	 *   protected register() {
	 *     this.resources({
	 *       index: (c) => c.text("books-index"),
	 *       show: (c) => c.text(`book-${c.req.param("id")}`),
	 *     });
	 *   }
	 * }
	 * ```
	 */
	protected resources(actions: ResourceActions<E>): void {
		if (actions.index) this.get("/", actions.index);
		if (actions.new) this.get("/new", actions.new);
		if (actions.create) this.post("/", actions.create);
		if (actions.show) this.get("/:id", actions.show);
		if (actions.edit) this.get("/:id/edit", actions.edit);
		if (actions.update) this.on(["PATCH", "PUT"], "/:id", actions.update);
		if (actions.destroy) this.delete("/:id", actions.destroy);
	}

	constructor() {
		super();
		const layout = this.layout();
		if (layout) this.use(jsxRenderer(layout));
		for (const mw of this.middleware()) this.use(mw);
		this.register();
	}
}
