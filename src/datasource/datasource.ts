/**
 * Abstract base for treating an external HTTP/REST data source "like a
 * Model": the same `fetch`-injection and `timeoutSignal` pattern as
 * `UpstashRedisStore`/`FetchMailer`, but for arbitrary request/response
 * shapes instead of one fixed API. The key difference from `Model` (which
 * trusts already-normalized input coming from the application's own
 * database) is that a `Datasource` talks to a system outside this
 * application's control, so every response body is untrusted external data
 * and must be validated with a Standard Schema before it's handed back to
 * the caller — the same sync/async validation pattern `Form` uses.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { timeoutSignal } from "../support/fetch_timeout.js";
import {
	DatasourceError,
	DatasourceParseError,
	DatasourceValidationError,
	MAX_ERROR_BODY_LENGTH,
} from "./datasource_error.js";

export type DatasourceQueryValue = string | number | boolean | undefined;
export type DatasourceQuery = Record<string, DatasourceQueryValue> | URLSearchParams;

export type DatasourceConfig = {
	/** Base URL every request is resolved against, e.g. `"https://api.example.com/v1"`. A trailing slash is trimmed. */
	baseUrl: string;
	/** For test injection. Defaults to the global `fetch` if omitted. */
	fetch?: typeof fetch;
	/** Timeout for requests, in milliseconds, applied via `timeoutSignal`. No timeout if omitted. */
	timeoutMs?: number;
	/** Default headers merged into every request (e.g. an `Authorization` header). */
	headers?: HeadersInit;
};

export type RequestOptions<T = unknown> = {
	/** Defaults to `GET` (the same default `fetch` itself uses). */
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	query?: DatasourceQuery;
	/** See `serializeBody` for how this is turned into a request body. */
	body?: unknown;
	/** Per-call headers, merged over the config-level default headers. */
	headers?: HeadersInit;
	/** When given, the response body is validated against this schema before being returned. */
	schema?: StandardSchemaV1<unknown, T>;
};

/**
 * Narrows `value` to an `ArrayBufferView` backed by a plain `ArrayBuffer`
 * (not a `SharedArrayBuffer`, which `BodyInit` doesn't accept). Covers
 * TypedArrays (`Uint8Array`, ...) and `DataView`.
 */
const isArrayBufferView = (value: unknown): value is ArrayBufferView<ArrayBuffer> =>
	ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer;

/**
 * Splits `body` into a `fetch`-compatible `BodyInit` plus the `content-type`
 * it implies, if any. Each branch returns its narrowed value directly (no
 * cast needed) so `fetch` can set the correct content-type itself for
 * `FormData`/`URLSearchParams`/`Blob`; anything else is treated as a plain
 * JSON payload.
 */
const serializeBody = (
	body: unknown,
): { body: BodyInit | undefined; contentType: string | undefined } => {
	if (body === undefined) return { body: undefined, contentType: undefined };
	if (typeof body === "string") return { body, contentType: undefined };
	if (body instanceof FormData) return { body, contentType: undefined };
	if (body instanceof URLSearchParams) return { body, contentType: undefined };
	if (body instanceof Blob) return { body, contentType: undefined };
	if (body instanceof ArrayBuffer) return { body, contentType: undefined };
	// Without this branch, a TypedArray/DataView body would fall through to
	// JSON.stringify and be corrupted into `{"0":...}`.
	if (isArrayBufferView(body)) return { body, contentType: undefined };
	if (body instanceof ReadableStream) return { body, contentType: undefined };
	return { body: JSON.stringify(body), contentType: "application/json" };
};

/** Builds a query string from a `DatasourceQuery`, skipping `undefined` values when given a plain object. */
const toSearchParams = (query?: DatasourceQuery): string => {
	if (query === undefined) return "";
	if (query instanceof URLSearchParams) return query.toString();
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query)) {
		if (value === undefined) continue;
		params.set(key, String(value));
	}
	return params.toString();
};

/** Copies every header from `extra` onto `target`, overwriting same-named entries already on `target`. */
const mergeHeaders = (target: Headers, extra?: HeadersInit): void => {
	new Headers(extra).forEach((value, key) => target.set(key, value));
};

/**
 * Parses a response body as JSON, treating an empty body (or a `204`/`205`
 * status, which by definition carries no body) as `undefined`. Throws
 * `DatasourceParseError` if the body is non-empty but not valid JSON.
 */
const parseResponse = async (response: Response): Promise<unknown> => {
	if (response.status === 204 || response.status === 205) return undefined;
	const text = await response.text();
	if (text === "") return undefined;
	try {
		const parsed: unknown = JSON.parse(text);
		return parsed;
	} catch {
		throw new DatasourceParseError(text.slice(0, MAX_ERROR_BODY_LENGTH));
	}
};

/**
 * Reads the response body as text for an error, tolerating a body that can't
 * be read twice. Truncated to `MAX_ERROR_BODY_LENGTH` so a large error page
 * or payload isn't held in memory in full.
 */
const safeText = async (response: Response): Promise<string> => {
	try {
		const text = await response.text();
		return text.slice(0, MAX_ERROR_BODY_LENGTH);
	} catch {
		return "";
	}
};

export abstract class Datasource {
	protected readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number | undefined;
	private readonly defaultHeaders: HeadersInit | undefined;

	constructor(config: DatasourceConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.fetchFn = config.fetch ?? fetch;
		this.timeoutMs = config.timeoutMs;
		this.defaultHeaders = config.headers;
	}

	/** Overload used when `options.schema` is given: the response is validated and `T` is returned. */
	protected request<T>(
		path: string,
		options: RequestOptions<T> & { schema: StandardSchemaV1<unknown, T> },
	): Promise<T>;
	/** Overload used without a schema: the parsed (but unvalidated) response body is returned. */
	protected request(path: string, options?: RequestOptions): Promise<unknown>;
	protected async request<T>(path: string, options: RequestOptions<T> = {}): Promise<unknown> {
		const url = this.buildUrl(path, options.query);
		const { body, contentType } = serializeBody(options.body);

		const headers = new Headers(this.defaultHeaders);
		if (contentType && !headers.has("content-type")) headers.set("content-type", contentType);
		mergeHeaders(headers, options.headers);

		const response = await this.fetchFn(url, {
			method: options.method,
			body,
			headers,
			signal: timeoutSignal(this.timeoutMs),
		});

		if (!response.ok) {
			throw new DatasourceError(
				options.method ?? "GET",
				url,
				response.status,
				await safeText(response),
			);
		}

		const parsed = await parseResponse(response);
		return options.schema ? this.validate(options.schema, parsed) : parsed;
	}

	/**
	 * Validates `value` against `schema`. Standard Schema's `validate` may
	 * return sync or async, so both are awaited uniformly (the same approach
	 * `Form#validate` uses). Throws `DatasourceValidationError` on failure.
	 */
	protected async validate<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): Promise<T> {
		const rawResult = schema["~standard"].validate(value);
		const result = rawResult instanceof Promise ? await rawResult : rawResult;
		if (result.issues) throw new DatasourceValidationError(result.issues);
		return result.value;
	}

	/**
	 * Resolves `path` against `baseUrl` with plain string concatenation
	 * rather than `new URL(path, baseUrl)`: the latter drops any path prefix
	 * already present on `baseUrl` (e.g. the `/v1` in
	 * `https://api.example.com/v1`) whenever `path` starts with `/`.
	 */
	private buildUrl(path: string, query?: DatasourceQuery): string {
		const search = toSearchParams(query);
		if (!search) return `${this.baseUrl}${path}`;
		// If `path` already carries its own query string, append with `&` instead of `?`.
		const separator = path.includes("?") ? "&" : "?";
		return `${this.baseUrl}${path}${separator}${search}`;
	}
}
