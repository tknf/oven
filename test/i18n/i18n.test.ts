/**
 * Tests for the i18n layer (`Translator` / `defaultTranslator`).
 * Integration with `languageDetector` (from `hono/language`) is verified by wiring up a real
 * Hono app and driving it through `app.request()`.
 */
import { Hono } from "hono";
import { languageDetector } from "hono/language";
import { describe, expect, test } from "vite-plus/test";
import type { CatalogBundle, PluralForms } from "../../src/i18n/i18n.js";
import { defaultTranslator, Translator } from "../../src/i18n/i18n.js";

const greetingBundle = {
	ja: { greeting: "こんにちは、{name}さん" },
	en: { greeting: "Hello, {name}" },
} satisfies CatalogBundle<{ greeting: string }>;

describe("Translator", () => {
	test("looks up text from the catalog for the language languageDetector detected", async () => {
		const { t } = new Translator(greetingBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "greeting", { name: "太郎" })));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("Hello, 太郎");
	});

	test("falls back to fallbackLanguage's catalog when the detected language isn't in the bundle", async () => {
		const { t } = new Translator(greetingBundle, { fallbackLanguage: "ja" });

		// languageDetector supports fr, but greetingBundle only has ja/en catalogs.
		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "fr"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "greeting", { name: "花子" })));

		const res = await app.request("/", { headers: { "Accept-Language": "fr" } });

		expect(await res.text()).toBe("こんにちは、花子さん");
	});

	test("falls back safely to fallbackLanguage even when languageDetector isn't applied (no language detected)", async () => {
		const { t } = new Translator(greetingBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "greeting", { name: "次郎" })));

		const res = await app.request("/");

		expect(await res.text()).toBe("こんにちは、次郎さん");
	});

	test("leaves a placeholder untouched when params has no matching value", async () => {
		const { t } = new Translator(greetingBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "greeting")));

		const res = await app.request("/");

		expect(await res.text()).toBe("こんにちは、{name}さん");
	});

	test("throws at construction time when fallbackLanguage isn't in the bundle", () => {
		expect(() => new Translator(greetingBundle, { fallbackLanguage: "fr" })).toThrow(
			/fallbackLanguage/,
		);
	});

	test("falls back to fallbackLanguage's text when the selected catalog is missing a key", async () => {
		/**
		 * Builds a partial catalog (loosened to the generic `CatalogBundle` shape) where the
		 * `en` catalog has no `farewell` key, bypassing the type check the same way a
		 * dynamically-built catalog could at runtime.
		 */
		const partialBundle: CatalogBundle = {
			ja: { greeting: "こんにちは", farewell: "さようなら" },
			en: { greeting: "Hello" },
		};
		const { t } = new Translator(partialBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "farewell")));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("さようなら");
	});

	test("returns the key string itself (never throws) when the key is missing from every catalog", async () => {
		const partialBundle: CatalogBundle = {
			ja: { greeting: "こんにちは" },
			en: { greeting: "Hello" },
		};
		const { t } = new Translator(partialBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "missingEverywhere")));

		const res = await app.request("/");

		expect(await res.text()).toBe("missingEverywhere");
	});
});

describe("Translator (plural forms / PluralForms)", () => {
	const itemBundle = {
		en: { items: { one: "{count} item", other: "{count} items" } },
		ja: { items: { other: "{count}件" } },
	} satisfies CatalogBundle<{ items: PluralForms }>;

	test("uses the one category's text when count is 1 in en", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "items", { count: 1 })));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("1 item");
	});

	test("uses the other category's text when count is 2 or more in en", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "items", { count: 2 })));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("2 items");
	});

	test("ja has no one category, so the other text is used even when count is 1", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "items", { count: 1 })));

		const res = await app.request("/");

		expect(await res.text()).toBe("1件");
	});

	test("uses the zero text for count 0 when zero is explicitly defined", async () => {
		const zeroBundle = {
			en: { items: { zero: "no items", one: "{count} item", other: "{count} items" } },
		} satisfies CatalogBundle<{ items: PluralForms }>;
		const { t } = new Translator(zeroBundle, { fallbackLanguage: "en" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "items", { count: 0 })));

		const res = await app.request("/");

		expect(await res.text()).toBe("no items");
	});

	test("without a zero definition, count 0 follows Intl.PluralRules category selection (en)", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "items", { count: 0 })));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("0 items");
	});

	test("fails soft to other when count is unspecified", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "items")));

		const res = await app.request("/");

		expect(await res.text()).toBe("{count}件");
	});

	test("fails soft to other when count is not a number (a string)", async () => {
		const { t } = new Translator(itemBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "items", { count: "many" })));

		const res = await app.request("/");

		// Uses the other text "{count}件", then interpolates {count} with params.count ("many").
		expect(await res.text()).toBe("many件");
	});

	test("an existing string-value key is unaffected by plural handling and still works as before (regression)", async () => {
		const mixedBundle = {
			ja: { greeting: "こんにちは、{name}さん", items: { other: "{count}件" } },
		} satisfies CatalogBundle<{ greeting: string; items: PluralForms }>;
		const { t } = new Translator(mixedBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "greeting", { name: "三郎" })));

		const res = await app.request("/");

		expect(await res.text()).toBe("こんにちは、三郎さん");
	});

	test("falls back to the fallback catalog's PluralForms when the selected catalog lacks the key", async () => {
		const partialPluralBundle: CatalogBundle = {
			ja: { items: { other: "{count}件" } },
			en: { greeting: "Hello" },
		};
		const { t } = new Translator(partialPluralBundle, { fallbackLanguage: "ja" });

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(t(c, "items", { count: 3 })));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("3件");
	});

	test("fails soft to other (never throws) for an invalid language tag bundle key", async () => {
		const invalidLanguageBundle: CatalogBundle<{ items: PluralForms }> = {
			"invalid tag!": { items: { one: "{count} item", other: "{count} items" } },
		};
		const { t } = new Translator(invalidLanguageBundle, { fallbackLanguage: "invalid tag!" });

		const app = new Hono();
		app.get("/", (c) => c.text(t(c, "items", { count: 1 })));

		const res = await app.request("/");

		expect(await res.text()).toBe("1 items");
	});
});

describe("defaultTranslator", () => {
	test("looks up the English error message from the default catalog when no language is detected", async () => {
		const app = new Hono();
		app.get("/", (c) => c.text(defaultTranslator.t(c, "errors.notFound")));

		const res = await app.request("/");

		expect(await res.text()).toBe("Page not found");
	});

	test("looks up the English catalog when English is detected", async () => {
		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(defaultTranslator.t(c, "errors.serverError")));

		const res = await app.request("/", { headers: { "Accept-Language": "en" } });

		expect(await res.text()).toBe("An unexpected error occurred");
	});

	test("looks up the bundled Japanese catalog when Japanese is detected", async () => {
		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "ja" }));
		app.get("/", (c) => c.text(defaultTranslator.t(c, "errors.notFound")));

		const res = await app.request("/", { headers: { "Accept-Language": "ja" } });

		expect(await res.text()).toBe("ページが見つかりません");
	});
});
