/**
 * Tests for `NamedRoutes` (a class that generates URLs from named routes).
 */
import { describe, expect, test } from "vite-plus/test";
import { NamedRoutes } from "../../src/routing/named_routes.js";

const buildRoutes = () =>
	new NamedRoutes(
		{
			"books.index": "/books",
			"books.show": "/books/:id",
			"books.page": "/books/:id/pages/:page?",
			"books.chapter": "/books/:id/chapters/:chapterId{[0-9]+}",
		},
		{ baseUrl: "https://example.com/" },
	);

describe("NamedRoutes", () => {
	test("generates a relative path with no parameters", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.index")).toBe("/books");
	});

	test("generates a relative path with one parameter embedded", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: "42" })).toBe("/books/42");
	});

	test("generates a relative path with multiple parameters embedded", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.page", { id: "42", page: "3" })).toBe("/books/42/pages/3");
	});

	test("accepts a number value as a parameter", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: 42 })).toBe("/books/42");
	});

	test("encodes parameter values with encodeURIComponent (slash, Japanese characters)", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: "a/b" })).toBe("/books/a%2Fb");
		expect(routes.pathFor("books.show", { id: "本" })).toBe(`/books/${encodeURIComponent("本")}`);
	});

	test("embeds an optional parameter as-is when specified", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.page", { id: "42", page: "3" })).toBe("/books/42/pages/3");
	});

	test("removes the whole segment when an optional parameter is omitted", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.page", { id: "42" })).toBe("/books/42/pages");
	});

	test("strips the regex modifier {[0-9]+} from the name and treats it as a parameter", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.chapter", { id: "42", chapterId: "7" })).toBe(
			"/books/42/chapters/7",
		);
	});

	test("appends a query string for a single value via the query option", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: "42" }, { query: { q: "a b" } })).toBe(
			"/books/42?q=a+b",
		);
	});

	test("appends the same key multiple times for an array value in the query option", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: "42" }, { query: { tag: ["a", "b"] } })).toBe(
			"/books/42?tag=a&tag=b",
		);
	});

	test("does not append ? when the query option is an empty object", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.show", { id: "42" }, { query: {} })).toBe("/books/42");
	});

	test("urlFor generates an absolute URL prefixed with baseUrl", () => {
		const routes = buildRoutes();

		expect(routes.urlFor("books.show", { id: "42" })).toBe("https://example.com/books/42");
	});

	test("a trailing slash on baseUrl is normalized away", () => {
		const routes = buildRoutes();

		expect(routes.urlFor("books.index")).toBe("https://example.com/books");
	});

	test("throws with a clear message when urlFor is called without baseUrl set", () => {
		const routes = new NamedRoutes({ "books.index": "/books" });

		expect(() => routes.urlFor("books.index")).toThrow(/baseUrl/);
	});

	test("throws in the constructor when baseUrl does not start with http(s)", () => {
		expect(() => new NamedRoutes({ "books.index": "/books" }, { baseUrl: "example.com" })).toThrow(
			/baseUrl/,
		);
	});

	test("throws in the constructor for a path template containing a wildcard (*)", () => {
		expect(
			() =>
				new NamedRoutes({
					"files.show": "/files/*",
				}),
		).toThrow(/files\.show/);
	});

	test("also removes the whole segment when only the optional parameter is an empty string", () => {
		const routes = buildRoutes();

		expect(routes.pathFor("books.page", { id: "42", page: "" })).toBe("/books/42/pages");
	});

	test("a destructured pathFor works standalone", () => {
		const { pathFor } = buildRoutes();

		expect(pathFor("books.show", { id: "42" })).toBe("/books/42");
	});

	test("a destructured urlFor works standalone", () => {
		const { urlFor } = buildRoutes();

		expect(urlFor("books.show", { id: "42" })).toBe("https://example.com/books/42");
	});
});
