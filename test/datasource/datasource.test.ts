/**
 * Verifies `Datasource` (the abstract base for treating an external HTTP/REST
 * API "like a Model"). `request`/`validate` are protected, so a minimal test
 * subclass exposes thin public wrappers around them. No external schema
 * library is used; following `form.test.ts`, a self-contained stub reproduces
 * Standard Schema according to the standardschema.dev specification.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, test, vi } from "vite-plus/test";
import type { DatasourceConfig, RequestOptions } from "../../src/datasource/datasource.js";
import { Datasource } from "../../src/datasource/datasource.js";
import {
	DatasourceParseError,
	DatasourceValidationError,
} from "../../src/datasource/datasource_error.js";

/** Minimal Standard Schema implementation for tests. `validate` can be given either sync or async. */
const defineStubSchema = <Output>(
	validate: (
		value: unknown,
	) => StandardSchemaV1.Result<Output> | Promise<StandardSchemaV1.Result<Output>>,
): StandardSchemaV1<unknown, Output> => ({
	"~standard": {
		version: 1,
		vendor: "oven-test",
		validate,
	},
});

/** Exposes `Datasource#request`/`validate` (both protected) as public methods for direct testing. */
class TestDatasource extends Datasource {
	callRequest<T>(
		path: string,
		options: RequestOptions<T> & { schema: StandardSchemaV1<unknown, T> },
	): Promise<T>;
	callRequest(path: string, options?: RequestOptions): Promise<unknown>;
	callRequest<T>(path: string, options: RequestOptions<T> = {}): Promise<unknown> {
		return this.request(path, options);
	}

	callValidate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
		return this.validate(schema, value);
	}
}

/** A dummy fetch that returns a JSON `Response`, wrapped in `vi.fn` so call arguments can be verified. */
const buildFetch = (body: unknown, status = 200) =>
	vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

const buildDatasource = (config: Partial<DatasourceConfig> & Pick<DatasourceConfig, "fetch">) =>
	new TestDatasource({ baseUrl: "https://api.example.com/v1", ...config });

describe("Datasource", () => {
	describe("URL building", () => {
		test("resolves path against baseUrl", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users");

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users");
		});

		test("preserves the baseUrl path prefix even when path starts with a slash (not new URL semantics)", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users/1");

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users/1");
		});

		test("a trailing slash on baseUrl is trimmed", async () => {
			const fetch = buildFetch({});
			const ds = new TestDatasource({ baseUrl: "https://api.example.com/v1/", fetch });

			await ds.callRequest("/users");

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users");
		});

		test("a plain-object query builds a search string, skipping undefined values and stringifying others", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users", { query: { page: 2, active: true, name: undefined } });

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users?page=2&active=true");
		});

		test("a URLSearchParams query is passed through as-is", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users", { query: new URLSearchParams({ q: "a b" }) });

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users?q=a+b");
		});

		test("a query is appended with & when path already contains its own query string", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users?a=1", { query: { b: 2 } });

			const [url] = fetch.mock.calls[0];
			expect(url).toBe("https://api.example.com/v1/users?a=1&b=2");
		});
	});

	describe("headers", () => {
		test("default headers from config are merged into every request", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch, headers: { authorization: "Bearer token" } });

			await ds.callRequest("/users");

			const [, init] = fetch.mock.calls[0];
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer token");
		});

		test("per-call headers overwrite same-named default headers", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch, headers: { "x-source": "default" } });

			await ds.callRequest("/users", { headers: { "x-source": "override" } });

			const [, init] = fetch.mock.calls[0];
			const headers = new Headers(init?.headers);
			expect(headers.get("x-source")).toBe("override");
		});
	});

	describe("body serialization", () => {
		test("a plain-object body is JSON-stringified and content-type is set to application/json", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users", { method: "POST", body: { name: "Alice" } });

			const [, init] = fetch.mock.calls[0];
			expect(init?.body).toBe(JSON.stringify({ name: "Alice" }));
			const headers = new Headers(init?.headers);
			expect(headers.get("content-type")).toBe("application/json");
		});

		test("a string body is passed through as-is without a json content-type", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });

			await ds.callRequest("/users", { method: "POST", body: "raw text" });

			const [, init] = fetch.mock.calls[0];
			expect(init?.body).toBe("raw text");
			const headers = new Headers(init?.headers);
			expect(headers.has("content-type")).toBe(false);
		});

		test("a URLSearchParams body is passed through without content-type being forced", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });
			const body = new URLSearchParams({ a: "1" });

			await ds.callRequest("/users", { method: "POST", body });

			const [, init] = fetch.mock.calls[0];
			expect(init?.body).toBe(body);
			const headers = new Headers(init?.headers);
			expect(headers.has("content-type")).toBe(false);
		});

		test("a FormData body is passed through without content-type being forced", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });
			const body = new FormData();
			body.set("a", "1");

			await ds.callRequest("/users", { method: "POST", body });

			const [, init] = fetch.mock.calls[0];
			expect(init?.body).toBe(body);
			const headers = new Headers(init?.headers);
			expect(headers.has("content-type")).toBe(false);
		});

		test("a TypedArray body is passed through as-is without being JSON-stringified", async () => {
			const fetch = buildFetch({});
			const ds = buildDatasource({ fetch });
			const body = new Uint8Array([1, 2, 3]);

			await ds.callRequest("/users", { method: "POST", body });

			const [, init] = fetch.mock.calls[0];
			expect(init?.body).toBe(body);
			const headers = new Headers(init?.headers);
			expect(headers.has("content-type")).toBe(false);
		});
	});

	describe("response handling", () => {
		test("a non-2xx response throws DatasourceError carrying status/method/url/body", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => new Response("not found", { status: 404 }));
			const ds = buildDatasource({ fetch: fetchFn });

			const error = await ds
				.callRequest("/users/1", { method: "GET" })
				.catch((err: unknown) => err);

			expect(error).toMatchObject({
				name: "DatasourceError",
				status: 404,
				method: "GET",
				url: "https://api.example.com/v1/users/1",
				body: "not found",
			});
		});

		test("a 204 status returns undefined", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
			const ds = buildDatasource({ fetch: fetchFn });

			await expect(ds.callRequest("/users")).resolves.toBeUndefined();
		});

		test("an empty body on a 2xx response returns undefined", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => new Response("", { status: 200 }));
			const ds = buildDatasource({ fetch: fetchFn });

			await expect(ds.callRequest("/users")).resolves.toBeUndefined();
		});

		test("a 2xx response with invalid JSON throws DatasourceParseError", async () => {
			const fetchFn = vi.fn<typeof fetch>(async () => new Response("not json", { status: 200 }));
			const ds = buildDatasource({ fetch: fetchFn });

			const error = await ds.callRequest("/users").catch((err: unknown) => err);

			expect(error).toBeInstanceOf(DatasourceParseError);
			expect(error).toMatchObject({ body: "not json" });
		});
	});

	describe("schema validation", () => {
		test("a successful sync schema returns the validated typed value", async () => {
			const fetch = buildFetch({ id: 1, name: "Alice" });
			const ds = buildDatasource({ fetch });
			const schema = defineStubSchema<{ id: number }>((value) => ({
				value: value as { id: number },
			}));

			await expect(ds.callRequest("/users/1", { schema })).resolves.toEqual({
				id: 1,
				name: "Alice",
			});
		});

		test("a successful async schema returns the validated typed value", async () => {
			const fetch = buildFetch({ id: 1 });
			const ds = buildDatasource({ fetch });
			const schema = defineStubSchema<{ id: number }>(async (value) => ({
				value: value as { id: number },
			}));

			await expect(ds.callRequest("/users/1", { schema })).resolves.toEqual({ id: 1 });
		});

		test("a failing schema throws DatasourceValidationError carrying issues", async () => {
			const fetch = buildFetch({ id: "not-a-number" });
			const ds = buildDatasource({ fetch });
			const schema = defineStubSchema<{ id: number }>(() => ({
				issues: [{ message: "id must be a number", path: ["id"] }],
			}));

			const error = await ds.callRequest("/users/1", { schema }).catch((err: unknown) => err);

			expect(error).toBeInstanceOf(DatasourceValidationError);
			expect((error as DatasourceValidationError).issues).toEqual([
				{ message: "id must be a number", path: ["id"] },
			]);
		});

		test("Datasource#validate directly rejects on a failing async schema", async () => {
			const ds = buildDatasource({ fetch: buildFetch({}) });
			const schema = defineStubSchema<never>(async () => ({
				issues: [{ message: "always fails" }],
			}));

			await expect(ds.callValidate(schema, {})).rejects.toBeInstanceOf(DatasourceValidationError);
		});
	});

	describe("timeout", () => {
		test("when timeoutMs is set, an AbortSignal is passed to fetch", async () => {
			const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
				expect(init?.signal).toBeInstanceOf(AbortSignal);
				return new Response(JSON.stringify({}), { status: 200 });
			});
			const ds = buildDatasource({ fetch: fetchFn, timeoutMs: 5000 });

			await ds.callRequest("/users");

			expect(fetchFn).toHaveBeenCalledOnce();
		});

		test("when timeoutMs is omitted, fetch is called without a signal", async () => {
			const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
				expect(init?.signal).toBeUndefined();
				return new Response(JSON.stringify({}), { status: 200 });
			});
			const ds = buildDatasource({ fetch: fetchFn });

			await ds.callRequest("/users");

			expect(fetchFn).toHaveBeenCalledOnce();
		});
	});
});
