/**
 * Tests for `domId` (the Turbo Stream target id generation convention).
 */
import { describe, expect, test } from "vite-plus/test";
import { domId } from "../../src/helpers/dom_id.js";

describe("domId", () => {
	test("passing an id produces the `prefix_id` form", () => {
		expect(domId("book", "123")).toBe("book_123");
	});

	test("omitting id produces the `new_prefix` form for a new record", () => {
		expect(domId("book")).toBe("new_book");
	});

	test("characters unsafe for an HTML id, such as spaces, are encodeURIComponent-escaped", () => {
		expect(domId("batch", "spring sale")).toBe("batch_spring%20sale");
	});
});
