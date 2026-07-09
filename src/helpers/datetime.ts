/**
 * View-layer date/time formatting helper.
 *
 * The framework layer has no knowledge of a given app's timezone, so
 * **`timeZone` is a required argument** (it never falls back to an implicit
 * runtime-default timezone, which varies by host — e.g. the local OS
 * timezone on Node, and a fixed UTC on Cloudflare Workers).
 */

/** Options for `formatDateTime`. `timeZone` is an IANA timezone name (e.g. `"Asia/Tokyo"`). */
export interface FormatDateTimeOptions {
	/** IANA timezone name passed through to `Intl.DateTimeFormat`. Required. */
	timeZone: string;
	/**
	 * Locale for `Intl.DateTimeFormat` (e.g. `"ja-JP"`). When omitted, this
	 * defers to `toLocaleString`'s default (the runtime's ICU default locale).
	 * Deliberately left without a default: if the framework layer hardcoded a
	 * specific locale such as `"ja-JP"` as the default, it would contradict the
	 * scope of the i18n layer, which is limited to the app's own message
	 * catalog (it must not implicitly assume the app's language).
	 */
	locale?: string;
}

/** Formats an epoch ms value (e.g. from `Date.now()`) as a date/time string in the given timezone and locale. */
export const formatDateTime = (epochMs: number, options: FormatDateTimeOptions): string =>
	new Date(epochMs).toLocaleString(options.locale, { timeZone: options.timeZone });
