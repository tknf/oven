/**
 * Tests for `formatCurrency` (the currency formatting helper).
 */
import { describe, expect, test } from "vite-plus/test";
import { formatCurrency } from "../../src/helpers/currency.js";

describe("formatCurrency", () => {
	test("JPY with the ja-JP locale renders as yen (no decimal digits)", () => {
		expect(formatCurrency(1200, { currency: "JPY", locale: "ja-JP" })).toBe("￥1,200");
	});

	test("USD with the en-US locale renders as dollars (2 decimal digits)", () => {
		expect(formatCurrency(12.5, { currency: "USD", locale: "en-US" })).toBe("$12.50");
	});

	test("the same amount and currency render with a different symbol depending on locale (fullwidth ￥ vs halfwidth ¥)", () => {
		const ja = formatCurrency(1000, { currency: "JPY", locale: "ja-JP" });
		const en = formatCurrency(1000, { currency: "JPY", locale: "en-US" });

		expect(ja).not.toBe(en);
	});
});
