/**
 * Tests for `ViteAssets`. Since JSX literals cannot be used in `.test.ts`, the return value
 * (`JSXNode`) of calling components as functions is passed to `c.html()` to verify the
 * rendered output (the same Hono-based verification approach as
 * `test/mailer/mail_preview_handler.test.ts`).
 */
import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import type { ViteManifest } from "../../src/vite/manifest.js";
import { ViteAssets, ViteEntryNotFoundError } from "../../src/vite/vite_assets.js";

/** Factory function that generates a test manifest by overriding a base manifest. */
const buildManifest = (overrides: ViteManifest = {}): ViteManifest => ({
	"src/client.ts": {
		file: "assets/client-abc123.js",
		css: ["assets/client-def456.css"],
		imports: ["_shared-ghi789.js"],
		isEntry: true,
	},
	"_shared-ghi789.js": {
		file: "assets/shared-ghi789.js",
	},
	"src/style.css": {
		file: "assets/style-jkl012.css",
		isEntry: true,
	},
	...overrides,
});

describe("ViteAssets", () => {
	test("throws on construction when mode=production and manifest is not specified", () => {
		expect(() => new ViteAssets({ mode: "production" })).toThrow();
	});

	describe("development", () => {
		const assets = new ViteAssets({ mode: "development", base: "/" });

		test("Script has type=module and src set to the raw source path", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Script({ name: "src/client.ts" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('type="module"');
			expect(body).toContain('src="/src/client.ts"');
		});

		test("ViteClient renders /@vite/client", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.ViteClient() ?? ""));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/@vite/client"');
		});

		test("Link renders the raw css path", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Link({ name: "src/style.css" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('rel="stylesheet"');
			expect(body).toContain('href="/src/style.css"');
		});

		test("asset returns the raw source path", () => {
			expect(assets.asset("src/logo.png")).toBe("/src/logo.png");
		});

		test("Img renders the raw source path as src", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Img({ name: "src/logo.png" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/src/logo.png"');
		});
	});

	describe("production", () => {
		const assets = new ViteAssets({
			mode: "production",
			manifest: buildManifest({
				"src/logo.png": { file: "assets/logo-abc123.png" },
			}),
			base: "/",
		});

		test("Script renders the js, css, and modulepreload resolved from the manifest", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Script({ name: "src/client.ts" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/assets/client-abc123.js"');
			expect(body).toContain('rel="stylesheet"');
			expect(body).toContain('href="/assets/client-def456.css"');
			expect(body).toContain('rel="modulepreload"');
			expect(body).toContain('href="/assets/shared-ghi789.js"');
		});

		test("does not emit modulepreload when preload=false", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Script({ name: "src/client.ts", preload: false })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/assets/client-abc123.js"');
			expect(body).not.toContain('rel="modulepreload"');
		});

		test("Link renders the manifest-resolved result of the css entry", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Link({ name: "src/style.css" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('rel="stylesheet"');
			expect(body).toContain('href="/assets/style-jkl012.css"');
		});

		test("ViteClient renders nothing", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.ViteClient() ?? ""));

			const body = await (await app.request("/")).text();

			expect(body).toBe("");
		});

		test("throws ViteEntryNotFoundError when resolving an unknown entry name", () => {
			expect(() => assets.resolveEntry("nope")).toThrow(ViteEntryNotFoundError);
		});

		test("asset returns the manifest-resolved fingerprinted URL", () => {
			expect(assets.asset("src/logo.png")).toBe("/assets/logo-abc123.png");
		});

		test("Img renders the manifest-resolved src and rest attributes", async () => {
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Img({ name: "src/logo.png", alt: "logo" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/assets/logo-abc123.png"');
			expect(body).toContain('alt="logo"');
		});

		test("throws ViteEntryNotFoundError when resolving an unknown entry name via asset", () => {
			expect(() => assets.asset("nope")).toThrow(ViteEntryNotFoundError);
		});
	});

	describe("base prefix", () => {
		test("does not produce a double slash even when base is /static/", async () => {
			const assets = new ViteAssets({ mode: "development", base: "/static/" });
			const app = new Hono();
			app.get("/", (c) => c.html(assets.Script({ name: "src/client.ts" })));

			const body = await (await app.request("/")).text();

			expect(body).toContain('src="/static/src/client.ts"');
			expect(body).not.toContain("//src/client.ts");
		});

		test("asset also does not produce a double slash even when base is /static/", () => {
			const assets = new ViteAssets({ mode: "development", base: "/static/" });

			expect(assets.asset("src/logo.png")).toBe("/static/src/logo.png");
		});
	});
});
