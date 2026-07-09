/**
 * Verifies `View`, the multi-format view. Checks automatic dispatch driven by the Accept
 * header (default order's first entry, wildcards, 406, and excluding unimplemented formats),
 * direct invocation, and adding a custom content-type by overriding `formats()`.
 */
import type { Context, Env } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { ViewFormat } from "../../src/view/view.js";
import { View } from "../../src/view/view.js";

/** A View that implements only html/json. */
class BookView extends View {
	constructor(protected readonly title: string) {
		super();
	}

	html(c: Context<Env>): Response {
		return c.html(`<h1>${this.title}</h1>`);
	}

	json(c: Context<Env>): Response {
		return c.json({ title: this.title });
	}
}

/** A View that overrides nothing (the case where formats() is empty). */
class EmptyView extends View {}

/** A View that overrides `formats()` to prepend a custom turbo-stream-like content-type. */
class StreamableBookView extends BookView {
	protected formats(): ViewFormat<Env>[] {
		return [
			{
				name: "turboStream",
				contentTypes: ["text/vnd.turbo-stream.html"],
				handler: (c) =>
					c.body(`<turbo-stream>${this.title}</turbo-stream>`, 200, {
						"Content-Type": "text/vnd.turbo-stream.html; charset=UTF-8",
					}),
			},
			...super.formats(),
		];
	}
}

const buildApp = (view: View) => {
	const app = new Hono();
	app.get("/", view.respond);
	return app;
};

describe("View", () => {
	test("returns the first entry of formats() (default order) when there is no Accept header", async () => {
		const app = buildApp(new BookView("Night on the Galactic Railroad"));

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toContain("text/html");
		expect(await res.text()).toBe("<h1>Night on the Galactic Railroad</h1>");
	});

	test("json is dispatched when Accept: application/json is specified", async () => {
		const app = buildApp(new BookView("Night on the Galactic Railroad"));

		const res = await app.request("/", { headers: { Accept: "application/json" } });

		expect(res.headers.get("Content-Type")).toContain("application/json");
		expect(await res.json()).toEqual({ title: "Night on the Galactic Railroad" });
	});

	test("Accept: */* returns the first entry of formats()", async () => {
		const app = buildApp(new BookView("Night on the Galactic Railroad"));

		const res = await app.request("/", { headers: { Accept: "*/*" } });

		expect(await res.text()).toBe("<h1>Night on the Galactic Railroad</h1>");
	});

	test("an unimplemented format (e.g. csv) is excluded from dispatch candidates and requesting it returns 406", async () => {
		const app = buildApp(new BookView("Night on the Galactic Railroad"));

		const res = await app.request("/", { headers: { Accept: "text/csv" } });

		expect(res.status).toBe(406);
	});

	test("a View with no respondable formats returns 406 even without an Accept header", async () => {
		const app = buildApp(new EmptyView());

		const res = await app.request("/");

		expect(res.status).toBe(406);
	});

	test("overriding formats() to add a custom content-type makes it selectable via Accept", async () => {
		const app = buildApp(new StreamableBookView("Night on the Galactic Railroad"));

		const res = await app.request("/", { headers: { Accept: "text/vnd.turbo-stream.html" } });

		expect(res.headers.get("Content-Type")).toContain("text/vnd.turbo-stream.html");
		expect(await res.text()).toBe("<turbo-stream>Night on the Galactic Railroad</turbo-stream>");
	});

	test("a View with a custom formats() still picks the array's first entry (the added custom format) when Accept is unspecified", async () => {
		const app = buildApp(new StreamableBookView("Night on the Galactic Railroad"));

		const res = await app.request("/");

		expect(res.headers.get("Content-Type")).toContain("text/vnd.turbo-stream.html");
	});

	test("format methods can be called directly without going through respond", async () => {
		const view = new BookView("Night on the Galactic Railroad");
		const app = new Hono();
		app.get("/direct-json", (c) => view.json(c));

		const res = await app.request("/direct-json");

		expect(await res.json()).toEqual({ title: "Night on the Galactic Railroad" });
	});
});
