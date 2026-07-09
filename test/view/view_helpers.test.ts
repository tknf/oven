/**
 * Verifies `ViewHelpers`, a thin view helper layer built on top of `useRequestContext`.
 *
 * JSX literals cannot be used (vitest only targets `test/**\/*.test.ts`, not `.tsx`), so the
 * component-equivalent tree is built by calling `hono/jsx`'s `jsx()` function directly, mounted
 * as a plain `Hono` instance (not via `app.route`) under a real Hono app with `jsxRenderer`, and
 * the rendered result is verified with `app.request()`. `useRequestContext` only works inside the
 * renderer's context, so this integration-test style with a real app is required (same approach
 * as `route_handler.test.ts`).
 *
 * The type of `c.render(content, props)`'s second argument and of `content` depend on this test
 * file's own `ContextRenderer` module augmentation (below). `content` is declared with
 * `hono/jsx`'s `Child` type so that a `JSXNode` returned by `jsx()` can be passed (broader than
 * the app's own `string`-only declaration, but necessary to verify nested components without
 * writing `.tsx`).
 */
import type { Context, Env } from "hono";
import { Hono } from "hono";
import { raw } from "hono/html";
import type { Child } from "hono/jsx";
import { jsx } from "hono/jsx";
import { jsxRenderer } from "hono/jsx-renderer";
import { describe, expect, test } from "vite-plus/test";
import { CSRF_HEADER_NAME, Csrf } from "../../src/security/csrf.js";
import type { Catalog } from "../../src/i18n/i18n.js";
import { Translator } from "../../src/i18n/i18n.js";
import { InMemorySessionStorage } from "../../src/session/in_memory_session_storage.js";
import type { LayoutComponent } from "../../src/view/layout.js";
import { SessionAccessor } from "../../src/session/session_accessor.js";
import type { Session } from "../../src/session/session.js";
import { ViewHelpers } from "../../src/view/view_helpers.js";

type User = { name: string };
type AppEnv = Env & { Variables: { session: Session; user?: User } };

declare module "hono" {
	interface ContextRenderer {
		(content: Child, props: { title: string }): Response | Promise<Response>;
	}
}

/**
 * Minimal layout for tests. Embeds the tree built with `jsx()` directly as `children`, then
 * calls `.toString()` on the whole thing at the end. This call happens while the layout itself
 * is already being invoked under `RequestContext.Provider` (inside `jsxRenderer`'s rendering
 * pipeline), so nested child components can correctly obtain the `Context` even when calling
 * `useRequestContext()` (unlike `route_handler.test.ts`, which just returns a string directly —
 * that approach cannot verify child components that use `useRequestContext`, hence this shape).
 */
const testLayout: LayoutComponent = ({ title, children }) =>
	raw(
		jsx("html", {}, jsx("head", {}, jsx("title", {}, title)), jsx("body", {}, children)).toString(),
	);

const cookieHeaderFrom = (setCookieValue: string): string => {
	const [pair] = setCookieValue.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");
	return pair;
};

/** `flash()` returns `unknown`, so confirm it is a string before displaying it in a view. */
const asDisplayString = (value: unknown): string => (typeof value === "string" ? value : "");

describe("ViewHelpers", () => {
	describe("csrfToken", () => {
		const buildApp = () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
			const csrf = new Csrf<AppEnv>({ session: sessionAccessor.use });
			const helpers = new ViewHelpers<AppEnv>({ csrfToken: csrf.csrfToken });

			/**
			 * `helpers.csrfToken()` must be called inside a component function. `jsx()`'s
			 * arguments are evaluated eagerly as an ordinary function call, so embedding it
			 * directly as `jsx("div", {}, helpers.csrfToken())` would execute it before
			 * `c.render` (before `RequestContext` is provided). Wrapping it in a function
			 * component like `TokenView` and passing it as `jsx(TokenView, {})` defers the
			 * call until the tree is actually rendered.
			 */
			const TokenView = () => jsx("div", { id: "token" }, helpers.csrfToken());

			const app = new Hono<AppEnv>();
			app.use(sessionAccessor.register);
			app.use(jsxRenderer(testLayout));

			app.get("/form", (c) => c.render(jsx(TokenView, {}), { title: "Form" }));
			app.post("/submit", csrf.verify, (c) => c.text("accepted"));

			return app;
		};

		test("a token issued within a view passes a POST from the same session", async () => {
			const app = buildApp();

			const formRes = await app.request("/form");
			const setCookie = formRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");
			const body = await formRes.text();
			const match = body.match(/<div id="token">([^<]+)<\/div>/);
			if (!match?.[1]) throw new Error("Token was not rendered");
			const token = match[1];

			const submitRes = await app.request("/submit", {
				method: "POST",
				headers: { Cookie: cookieHeaderFrom(setCookie), [CSRF_HEADER_NAME]: token },
			});

			expect(submitRes.status).toBe(200);
			expect(await submitRes.text()).toBe("accepted");
		});

		test("tampering with the token causes the POST to be rejected with 403", async () => {
			const app = buildApp();

			const formRes = await app.request("/form");
			const setCookie = formRes.headers.get("Set-Cookie");
			if (!setCookie) throw new Error("Set-Cookie was not issued");

			const submitRes = await app.request("/submit", {
				method: "POST",
				headers: { Cookie: cookieHeaderFrom(setCookie), [CSRF_HEADER_NAME]: "tampered" },
			});

			expect(submitRes.status).toBe(403);
		});
	});

	describe("flash", () => {
		const buildApp = () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
			const helpers = new ViewHelpers<AppEnv>({ session: sessionAccessor.use });

			const NoticeView = () =>
				jsx("div", { id: "notice" }, asDisplayString(helpers.flash("notice")));

			const app = new Hono<AppEnv>();
			app.use(sessionAccessor.register);
			app.use(jsxRenderer(testLayout));

			app.get("/write", (c) => {
				sessionAccessor.use(c).flash("notice", "Saved!");
				return c.text("ok");
			});
			app.get("/show", (c) => c.render(jsx(NoticeView, {}), { title: "Show" }));

			return app;
		};

		test("a value stored via flash can be consumed once inside a view, and consuming it reissues Set-Cookie", async () => {
			const app = buildApp();

			const writeRes = await app.request("/write");
			const writeCookie = writeRes.headers.get("Set-Cookie");
			if (!writeCookie) throw new Error("Set-Cookie was not issued");

			const firstShow = await app.request("/show", {
				headers: { Cookie: cookieHeaderFrom(writeCookie) },
			});
			const showCookie = firstShow.headers.get("Set-Cookie");

			expect(await firstShow.text()).toContain('<div id="notice">Saved!</div>');
			expect(showCookie).not.toBeNull();

			const cookieForSecondShow = showCookie
				? cookieHeaderFrom(showCookie)
				: cookieHeaderFrom(writeCookie);
			const secondShow = await app.request("/show", {
				headers: { Cookie: cookieForSecondShow },
			});

			expect(await secondShow.text()).toContain('<div id="notice"></div>');
			expect(secondShow.headers.get("Set-Cookie")).toBeNull();
		});
	});

	describe("currentUser", () => {
		const buildApp = () => {
			const app = new Hono<AppEnv>();
			app.use(async (c, next) => {
				if (c.req.header("X-Test-User") === "yes") c.set("user", { name: "Alice" });
				await next();
			});
			app.use(jsxRenderer(testLayout));

			const helpers = new ViewHelpers<AppEnv, Catalog, User>({
				currentUser: (c: Context<AppEnv>) => c.get("user"),
			});
			const UserView = () => jsx("div", { id: "user" }, helpers.currentUser()?.name ?? "Guest");

			app.get("/", (c) => c.render(jsx(UserView, {}), { title: "Home" }));

			return app;
		};

		test("currentUser() returns the user when authenticated", async () => {
			const app = buildApp();

			const res = await app.request("/", { headers: { "X-Test-User": "yes" } });

			expect(await res.text()).toContain('<div id="user">Alice</div>');
		});

		test("currentUser() behaves as undefined and displays Guest when unauthenticated (unset)", async () => {
			const app = buildApp();

			const res = await app.request("/");

			expect(await res.text()).toContain('<div id="user">Guest</div>');
		});
	});

	describe("t", () => {
		test("can retrieve catalog text within a view with parameter interpolation", async () => {
			const catalog = {
				ja: { greeting: "こんにちは、{name}さん" },
			} satisfies Record<string, Catalog>;
			const { t } = new Translator(catalog, { fallbackLanguage: "ja" });
			const helpers = new ViewHelpers<Env>({ t });
			const GreetingView = () =>
				jsx("div", { id: "greeting" }, helpers.t("greeting", { name: "太郎" }));

			const app = new Hono();
			app.use(jsxRenderer(testLayout));
			app.get("/", (c) => c.render(jsx(GreetingView, {}), { title: "Home" }));

			const res = await app.request("/");

			expect(await res.text()).toContain('<div id="greeting">こんにちは、太郎さん</div>');
		});
	});

	describe("failure modes", () => {
		test("throws a clear message when called outside the renderer (a route without jsxRenderer applied)", async () => {
			const helpers = new ViewHelpers<Env>({
				csrfToken: () => "unused",
			});

			const app = new Hono();
			app.onError((err, c) => c.text(err.message, 500));
			app.get("/", (c) => c.text(helpers.csrfToken()));

			const res = await app.request("/");

			expect(res.status).toBe(500);
			expect(await res.text()).toContain("RequestContext is not provided");
		});

		test("calling an unwired helper (one whose dependency was not passed) throws a clear message prompting wiring", () => {
			const helpers = new ViewHelpers<Env>({});

			expect(() => helpers.csrfToken()).toThrow(/csrfToken.*not wired up/);
			expect(() => helpers.flash("notice")).toThrow(/flash.*not wired up/);
			expect(() => helpers.currentUser()).toThrow(/currentUser.*not wired up/);
			expect(() => helpers.t("missing")).toThrow(/t.*not wired up/);
		});

		test("calling flash() without registering the session throws the session accessor's own clear message", async () => {
			const storage = new InMemorySessionStorage();
			const sessionAccessor = new SessionAccessor<AppEnv, "session">("session", storage);
			const helpers = new ViewHelpers<AppEnv>({ session: sessionAccessor.use });
			const NoticeView = () => jsx("div", {}, asDisplayString(helpers.flash("notice")));

			const app = new Hono<AppEnv>();
			// Deliberately does not apply sessionAccessor.register.
			app.use(jsxRenderer(testLayout));
			app.onError((err, c) => c.text(err.message, 500));
			app.get("/", (c) => c.render(jsx(NoticeView, {}), { title: "Home" }));

			const res = await app.request("/");

			expect(res.status).toBe(500);
			expect(await res.text()).toContain("session");
		});
	});
});
