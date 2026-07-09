/**
 * View-layer currency formatting helper. A thin wrapper around
 * `Intl.NumberFormat` (ECMA-402) with `style: "currency"`, leaving all
 * per-currency decimal digits, symbol placement, and grouping to Intl
 * (nothing is reimplemented here).
 */

/** Options for `formatCurrency`. Both `currency` and `locale` are required (no implicit default). */
export interface FormatCurrencyOptions {
	/** ISO 4217 currency code (e.g. `"JPY"`, `"USD"`). */
	currency: string;
	/** Locale for `Intl.NumberFormat` (e.g. `"ja-JP"`). */
	locale: string;
}

/**
 * Formats `amount` as currency using `options.currency`. `amount` must be
 * given in the currency's **major unit** (e.g. `1200` for ¥1,200, not
 * `120000`; `12` for $12.00, not `1200`). Converting from a "minor unit"
 * representation (e.g. Stripe's cents, which varies from 0 to 3 decimal
 * places depending on the currency) is the caller's responsibility. Adding a
 * table of per-currency decimal-place rules to this thin formatter would be
 * overkill; the caller — who knows where the amount came from (e.g. a
 * Stripe amount) — is in a better position to decide whether conversion is needed.
 */
export const formatCurrency = (amount: number, options: FormatCurrencyOptions): string =>
	new Intl.NumberFormat(options.locale, { style: "currency", currency: options.currency }).format(
		amount,
	);
