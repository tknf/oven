/**
 * A thin layer connecting `hono/language` (`languageDetector`) with message catalogs.
 *
 * **Intentionally narrow scope**: this module only covers cataloging "messages emitted by
 * the framework itself" (error pages, future validation copy, etc.) — it does not aim to be
 * the foundation for localizing an entire app (screen labels, body copy, etc.). If an app
 * wants to build its own large catalog, it can freely reuse the `Translator` class this
 * module provides (see below).
 *
 * `languageDetector` (from `hono/language`) pushes the detected language onto the context via
 * `c.set("language", lang)`. This side effect globally augments Hono's `ContextVariableMap`
 * (via the `declare module "hono"` inside `hono/language`'s type definitions), so calling
 * `c.get("language")` even from a `Context` where `languageDetector` was never actually
 * applied still type-checks as `string`. At runtime, though, the value is actually
 * `undefined` if the `languageDetector` middleware wasn't applied. This module's `t` assumes
 * that mismatch and falls back safely (to the fallback language) via a runtime
 * `typeof language === "string"` check.
 *
 * **Trust boundary**: catalog text (`ja`/`en`, etc. — fixed values owned by this module) is a
 * trusted value managed by developers, and `t`'s return value is not HTML-escaped. When
 * embedding it into a raw HTML string template (e.g. a `<title>` built via a template
 * literal), escaping is the embedding site's responsibility (usually a non-issue when used as
 * a text node in hono/jsx, since that auto-escapes). Be mindful of this non-escaping
 * assumption if untrusted user input is passed via `params` (the values `interpolate`
 * substitutes into `{name}` placeholders in the text).
 */
import type { Context } from "hono";
/**
 * A type-only re-export. This applies `hono/language`'s `declare module "hono"` augmentation
 * of `ContextVariableMap` (`language: string`) to every compilation unit that imports this
 * module. No runtime code is imported (type-only, so it disappears after build).
 */
export type { LanguageVariables } from "hono/language";

/**
 * Text per plural category. Keys correspond to the CLDR categories returned by
 * `Intl.PluralRules#select` (`zero`/`one`/`two`/`few`/`many`/`other`). `other` is required as
 * the final fallback for all categories (every CLDR language always has an `other` category).
 *
 * `zero` is an explicit convention: even languages that don't have a `zero` plural category in
 * CLDR (English, Japanese, etc.) often want dedicated text only when `count === 0` (e.g. "No
 * results"), so it's checked explicitly before category resolution rather than relying on
 * CLDR's category set alone.
 */
export type PluralForms = {
	zero?: string;
	one?: string;
	two?: string;
	few?: string;
	many?: string;
	other: string;
};

/**
 * A message catalog: a flat key-to-text lookup table. Values are either plain string
 * templates, or a `PluralForms` bundle (per-category text) for keys that need pluralization.
 */
export type Catalog = Record<string, string | PluralForms>;

/** A bundle of language code (`"ja"`, `"en"`, etc.) to catalog. */
export type CatalogBundle<C extends Catalog = Catalog> = Record<string, C>;

/** Interpolation parameters passed to `t`. `{name}` placeholders in the text are replaced with these values. */
export type TranslateParams = Record<string, string | number>;

/**
 * The type of `Translator#t`. `key` is narrowed to the keys catalog `C` has (so typos are
 * caught at compile time).
 */
export type Translate<C extends Catalog = Catalog> = (
	c: Context,
	key: keyof C & string,
	params?: TranslateParams,
) => string;

/**
 * Replaces `{name}`-style placeholders with the corresponding value from `params`. A
 * placeholder with no matching value is left untouched (to avoid the literal string
 * `undefined` accidentally showing up on screen; a missing param can't be detected at this
 * layer, so it's expected to be caught by the caller's tests).
 */
const interpolate = (template: string, params?: TranslateParams): string => {
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : placeholder,
	);
};

/**
 * A class that provides the translation function `t` from a catalog bundle `bundle`.
 * `options.fallbackLanguage` must exist in `bundle`; if it doesn't, an exception is thrown at
 * construction time (so a configuration mistake is caught at startup).
 *
 * `t(c, key, params?)` resolves the language in this order:
 * 1. `c.get("language")` (the detection result set by `languageDetector`)
 * 2. If 1 isn't present in `bundle` (unset or an unsupported language), fall back to `fallbackLanguage`
 *
 * After choosing the language (catalog), `key` resolution follows this fallback order, and
 * **never throws** (because a dynamically built catalog, or a partial catalog whose type was
 * loosened via `as`, can reach runtime with a missing key):
 * 1. `catalog[key]` from the selected catalog
 * 2. If absent, `fallbackCatalog[key]` from the `fallbackLanguage` catalog
 * 3. If still absent, return the `key` string itself
 *
 * The fail-soft judgment here is that for missing i18n text, "the raw key string is visible"
 * causes less damage than "the screen breaks with a 500" (whereas `error_handler.ts` hides
 * error details for the same reason, this module does the opposite — it deliberately shows
 * the key so developers notice the gap).
 *
 * If the resolved template is `PluralForms` (a bundle of per-category text), the actual text
 * is then chosen in this order (also **never throws**):
 * 1. Use `other` if `params?.count` isn't a `number` (fail-soft for an unspecified or
 *    wrong-typed `count`)
 * 2. Use `zero` if `count === 0` and `zero` is defined (the explicit convention for languages
 *    without a `zero` CLDR plural category; see the `PluralForms` type comment)
 * 3. Otherwise, the text for the category returned by
 *    `new Intl.PluralRules(language).select(count)`. Falls back to `other` if that category
 *    is absent, and also falls back to `other` if the language tag is invalid and the
 *    `Intl.PluralRules` constructor throws (`Intl.PluralRules` instances are cached per
 *    language in `pluralRulesCache`)
 * The chosen text is then interpolated the same way as a regular template
 * (`{count}` is also substituted here via `params`).
 *
 * `fallbackLanguage` is intentionally typed as `string` (not a literal type derived from
 * `bundle`'s keys). This is a deliberate simplification: the catalog bundle type
 * `CatalogBundle<C> = Record<string, C>` doesn't retain the set of language codes as a type
 * (an index signature collapses `Record<string, C>`'s keys), so preserving a literal union
 * would require intricate generics that infer `bundle` and `fallbackLanguage` together. Since
 * a catalog bundle doesn't change frequently as languages are added, and the runtime check
 * below is safe enough, that complexity was avoided.
 */
export class Translator<C extends Catalog> {
	private readonly bundle: CatalogBundle<C>;
	private readonly fallbackCatalog: C;
	private readonly fallbackLanguage: string;

	/** Cache of language tag to `Intl.PluralRules`, reused per language to avoid construction cost. */
	private readonly pluralRulesCache = new Map<string, Intl.PluralRules>();

	/** @throws {Error} If `bundle` has no catalog for `options.fallbackLanguage`. */
	constructor(bundle: CatalogBundle<C>, options: { fallbackLanguage: string }) {
		const fallbackCatalog = bundle[options.fallbackLanguage];
		if (!fallbackCatalog) {
			throw new Error(
				`No catalog found in bundle for fallbackLanguage "${options.fallbackLanguage}"`,
			);
		}

		this.bundle = bundle;
		this.fallbackCatalog = fallbackCatalog;
		this.fallbackLanguage = options.fallbackLanguage;
	}

	/** Passed by reference into `error_handler.ts` / `view_helpers.ts`, so it's an arrow-function class field. */
	readonly t: Translate<C> = (c, key, params) => {
		const language = c.get("language");
		const detected = typeof language === "string" && Object.hasOwn(this.bundle, language);
		const catalog = detected ? this.bundle[language] : this.fallbackCatalog;
		const catalogLanguage = detected ? language : this.fallbackLanguage;

		const resolved = this.resolveTemplate(catalog, catalogLanguage, key);
		if (!resolved) return key;

		const text =
			typeof resolved.template === "string"
				? resolved.template
				: this.selectPluralForm(resolved.template, resolved.language, params);
		return interpolate(text, params);
	};

	/**
	 * Looks up a template (string or `PluralForms`) in `catalog[key]`, then
	 * `fallbackCatalog[key]`. Also returns the language of whichever catalog matched (used for
	 * plural category resolution). Returns `undefined` if neither has it (the caller falls
	 * back to the `key` string).
	 */
	private resolveTemplate(catalog: C, catalogLanguage: string, key: keyof C & string) {
		const template = catalog[key];
		if (template !== undefined) return { template, language: catalogLanguage };

		const fallbackTemplate = this.fallbackCatalog[key];
		if (fallbackTemplate !== undefined) {
			return { template: fallbackTemplate, language: this.fallbackLanguage };
		}

		return undefined;
	}

	/**
	 * Selects the actual text to use from `PluralForms`. Falls back to `other` when `count`
	 * isn't a number, or when `Intl.PluralRules` doesn't have text for the resolved category
	 * (matching this class's "never throw" policy).
	 */
	private selectPluralForm(forms: PluralForms, language: string, params?: TranslateParams) {
		const count = params?.count;
		if (typeof count !== "number") return forms.other;
		if (count === 0 && forms.zero !== undefined) return forms.zero;

		const category = this.getPluralRules(language)?.select(count) ?? "other";
		return forms[category] ?? forms.other;
	}

	/**
	 * Returns the `Intl.PluralRules` for a language tag from the cache (constructing and
	 * caching it if absent). Returns `undefined` if the constructor throws (e.g. for an
	 * invalid BCP47 language tag), letting the caller fail soft to `other`.
	 */
	private getPluralRules(language: string) {
		const cached = this.pluralRulesCache.get(language);
		if (cached) return cached;

		try {
			const rules = new Intl.PluralRules(language);
			this.pluralRulesCache.set(language, rules);
			return rules;
		} catch {
			return undefined;
		}
	}
}

/**
 * The framework's default message catalog (English). This is the source of the 404/500 text
 * in `error_handler.ts`; the key names (`"errors.notFound"`, `"errors.serverError"`) form the
 * contract an app follows when overriding them by including the same keys in its own catalog.
 */
const en = {
	"errors.notFound": "Page not found",
	"errors.serverError": "An unexpected error occurred",
} satisfies Catalog;

/** The framework's default message catalog (Japanese), bundled alongside the required `en`. */
const ja = {
	"errors.notFound": "ページが見つかりません",
	"errors.serverError": "サーバーエラーが発生しました",
} satisfies Catalog;

/** The key set of the framework's default catalog. Used by `error_handler.ts` as the type for `t`. */
export type DefaultCatalog = typeof en;

/** The framework's default catalog bundle (`en` required, `ja` bundled alongside). */
export const defaultCatalogBundle: CatalogBundle<DefaultCatalog> = { en, ja };

/**
 * The default translator instance built from the framework's default catalog. `ErrorPages`
 * uses this when `options.t` isn't specified, so apps that haven't applied `languageDetector`
 * fall back to English (`en` is the fallback language) by default. Apps that detect Japanese
 * via `languageDetector` still get the bundled `ja` catalog.
 */
export const defaultTranslator = new Translator(defaultCatalogBundle, { fallbackLanguage: "en" });
