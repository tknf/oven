/**
 * Verifies `OffsetPaginationView` (the numbered page-link component paired
 * with `Model#listPage`'s offset pagination). Since JSX literals cannot be
 * used in `.test.ts`, this follows the same convention as
 * `pagination_view.test.ts`: calling the component directly as a function and
 * stringifying the result.
 */
import { describe, expect, test } from "vite-plus/test";
import { OffsetPaginationView } from "../../src/pagination/offset_pagination_view.js";

describe("OffsetPaginationView", () => {
	test("renders nothing when pageCount is 1 and no summary is given", async () => {
		const result = await OffsetPaginationView({
			page: 0,
			pageCount: 1,
			buildUrl: (p) => `/items?p=${p}`,
		});

		expect(result).toBeNull();
	});

	test("renders nothing when pageCount is 0 and no summary is given", async () => {
		const result = await OffsetPaginationView({
			page: 0,
			pageCount: 0,
			buildUrl: (p) => `/items?p=${p}`,
		});

		expect(result).toBeNull();
	});

	test("renders the nav with only the summary when pageCount is 1 but summary is given", async () => {
		const html = (
			await OffsetPaginationView({
				page: 0,
				pageCount: 1,
				buildUrl: (p) => `/items?p=${p}`,
				summary: "1 Item",
			})
		)?.toString();

		expect(html).toContain('<nav aria-label="pagination">');
		expect(html).toContain('<span class="result-count">1 Item</span>');
		expect(html).not.toContain("<a href");
	});

	test("renders numbered links with a 1-based display number and passes a 0-based index to buildUrl", async () => {
		const received: number[] = [];
		const html = (
			await OffsetPaginationView({
				page: 0,
				pageCount: 3,
				buildUrl: (p) => {
					received.push(p);
					return `/items?p=${p}`;
				},
			})
		)?.toString();

		expect(html).toContain('<a href="/items?p=1">2</a>');
		expect(html).toContain('<a href="/items?p=2">3</a>');
		expect(received).toContain(1);
		expect(received).toContain(2);
	});

	test("the current page renders as a span with aria-current, not a link", async () => {
		const html = (
			await OffsetPaginationView({
				page: 1,
				pageCount: 3,
				buildUrl: (p) => `/items?p=${p}`,
			})
		)?.toString();

		expect(html).toContain('<span class="this-page" aria-current="page">2</span>');
		expect(html).not.toContain('<a href="/items?p=1">2</a>');
	});

	test("elides a long page range down to the first 2, the last 2, and a window around the current page", async () => {
		const html = (
			await OffsetPaginationView({
				page: 9,
				pageCount: 20,
				buildUrl: (p) => `/items?p=${p}`,
			})
		)?.toString();

		// First 2 (1, 2), then an ellipsis before the ±3 window around page 9 (0-based) => 7..13 (1-based).
		expect(html).toMatch(/>1<\/a><a href="\/items\?p=1">2<\/a><span class="ellipsis">…<\/span>/);
		expect(html).toContain('<a href="/items?p=6">7</a>');
		expect(html).toContain('<span class="this-page" aria-current="page">10</span>');
		expect(html).toContain('<a href="/items?p=12">13</a>');
		// Another ellipsis before the last 2 (19, 20).
		expect(html).toContain(
			'<span class="ellipsis">…</span><a href="/items?p=18">19</a><a href="/items?p=19">20</a>',
		);
	});

	test("renders no ellipsis when the page range is small enough to show in full", async () => {
		const html = (
			await OffsetPaginationView({
				page: 2,
				pageCount: 5,
				buildUrl: (p) => `/items?p=${p}`,
			})
		)?.toString();

		expect(html).not.toContain("ellipsis");
		expect(html).toContain('<a href="/items?p=0">1</a>');
		expect(html).toContain('<a href="/items?p=1">2</a>');
		expect(html).toContain('<span class="this-page" aria-current="page">3</span>');
		expect(html).toContain('<a href="/items?p=3">4</a>');
		expect(html).toContain('<a href="/items?p=4">5</a>');
	});

	test("applies pageLabel as the page link's aria-label", async () => {
		const html = (
			await OffsetPaginationView({
				page: 0,
				pageCount: 2,
				buildUrl: (p) => `/items?p=${p}`,
				pageLabel: (n) => `Page ${n}`,
			})
		)?.toString();

		expect(html).toContain('aria-label="Page 2"');
	});

	test("omits aria-label from page links when pageLabel is not given", async () => {
		const html = (
			await OffsetPaginationView({
				page: 0,
				pageCount: 2,
				buildUrl: (p) => `/items?p=${p}`,
			})
		)?.toString();

		expect(html).toContain('<a href="/items?p=1">2</a>');
	});

	test("navLabel and attrs are reflected on the nav element", async () => {
		const html = (
			await OffsetPaginationView({
				page: 0,
				pageCount: 2,
				buildUrl: (p) => `/items?p=${p}`,
				navLabel: "Pagination",
				attrs: { class: "paginator" },
			})
		)?.toString();

		expect(html).toContain('aria-label="Pagination"');
		expect(html).toContain('class="paginator"');
	});
});
