/**
 * Verifies `PaginationView` (the "next" link component for cursor-based
 * pagination). Since JSX literals cannot be used in `.test.ts`, this follows
 * the same convention as `form_field.test.ts`: calling the component
 * directly as a function and stringifying the result.
 */
import { describe, expect, test } from "vite-plus/test";
import { PaginationView } from "../../src/pagination/pagination_view.js";

describe("PaginationView", () => {
	test("renders the next link when hasMore is true and nextCursor is present", async () => {
		const html = (
			await PaginationView({
				nextCursor: "123",
				hasMore: true,
				buildUrl: (cursor) => `/items?cursor=${cursor}`,
				label: "Next",
			})
		)?.toString();

		expect(html).toContain('<nav aria-label="pagination">');
		expect(html).toContain('<a href="/items?cursor=123" rel="next">Next</a>');
	});

	test("renders nothing when hasMore is false", async () => {
		const result = await PaginationView({
			nextCursor: "123",
			hasMore: false,
			buildUrl: (cursor) => `/items?cursor=${cursor}`,
			label: "Next",
		});

		expect(result).toBeNull();
	});

	test("renders nothing when nextCursor is null", async () => {
		const result = await PaginationView({
			nextCursor: null,
			hasMore: true,
			buildUrl: (cursor) => `/items?cursor=${cursor}`,
			label: "Next",
		});

		expect(result).toBeNull();
	});

	test("navLabel and attrs are reflected on the nav element", async () => {
		const html = (
			await PaginationView({
				nextCursor: "123",
				hasMore: true,
				buildUrl: (cursor) => `/items?cursor=${cursor}`,
				label: "Next",
				navLabel: "Pagination",
				attrs: { "data-turbo": false },
			})
		)?.toString();

		expect(html).toContain('aria-label="Pagination"');
		expect(html).toContain('data-turbo="false"');
	});

	test("a string cursor is passed to buildUrl", async () => {
		let received: string | number | undefined;
		await PaginationView({
			nextCursor: "abc",
			hasMore: true,
			buildUrl: (cursor) => {
				received = cursor;
				return "/items";
			},
			label: "Next",
		});

		expect(received).toBe("abc");
	});

	test("a numeric cursor is passed to buildUrl", async () => {
		let received: string | number | undefined;
		await PaginationView({
			nextCursor: 42,
			hasMore: true,
			buildUrl: (cursor) => {
				received = cursor;
				return "/items";
			},
			label: "Next",
		});

		expect(received).toBe(42);
	});
});
