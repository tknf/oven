/**
 * Error types raised by `Datasource`/`RestDatasource`.
 *
 * `DatasourceError` covers transport-level failures (a non-2xx HTTP
 * response), `DatasourceParseError` covers a 2xx response whose body isn't
 * valid JSON, and `DatasourceValidationError` covers the layer specific to
 * this module: an external response that came back with a 2xx status but
 * doesn't match the shape the caller declared via a Standard Schema. Unlike
 * `Model`, which trusts already-normalized input, a `Datasource` treats
 * every response body as untrusted external data and validates it, so these
 * failure modes are kept as distinct error types.
 */
import type { StandardSchemaV1 } from "@standard-schema/spec";

/** Maximum number of characters of the response body to include in a `DatasourceError` message. */
const RESPONSE_BODY_PREVIEW_LENGTH = 500;

/**
 * Maximum number of characters of the response body kept on `DatasourceError#body`
 * and `DatasourceParseError#body`. Larger than `RESPONSE_BODY_PREVIEW_LENGTH`
 * because `.body` is meant to be read programmatically (e.g. a structured
 * error payload), while the message preview only needs to be human-readable.
 */
export const MAX_ERROR_BODY_LENGTH = 8192;

/** Maximum number of issues rendered into a `DatasourceValidationError` message before truncating. */
const MAX_FORMATTED_ISSUES = 3;

/** Renders the first `path` segment as a plain field key, mirroring `Form`'s issue-to-field mapping. */
const formatIssuePath = (path: StandardSchemaV1.Issue["path"]): string => {
	if (!path || path.length === 0) return "(root)";
	const [first] = path;
	return String(typeof first === "object" ? first.key : first);
};

/** Formats a compact, human-readable summary of Standard Schema issues, capped at `MAX_FORMATTED_ISSUES`. */
const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string => {
	const formatted = issues
		.slice(0, MAX_FORMATTED_ISSUES)
		.map((issue) => `${formatIssuePath(issue.path)}: ${issue.message}`)
		.join("; ");
	return issues.length > MAX_FORMATTED_ISSUES ? `${formatted}; …` : formatted;
};

/** Thrown by `Datasource#request` when the underlying HTTP response is not 2xx. */
export class DatasourceError extends Error {
	readonly status: number;
	readonly method: string;
	readonly url: string;
	readonly body: string;

	constructor(method: string, url: string, status: number, body: string) {
		super(
			`Datasource request failed: ${method} ${url} responded ${status}: ${body.slice(0, RESPONSE_BODY_PREVIEW_LENGTH)}`,
		);
		this.name = "DatasourceError";
		this.status = status;
		this.method = method;
		this.url = url;
		this.body = body;
	}
}

/**
 * Thrown by `Datasource#request` when a 2xx response body is non-empty but
 * not valid JSON. Kept as its own error type (rather than a plain `Error`)
 * so it fits the same `instanceof`-checkable hierarchy as `DatasourceError`
 * and `DatasourceValidationError`.
 */
export class DatasourceParseError extends Error {
	readonly body: string;

	constructor(body: string) {
		super("Datasource: response body was not valid JSON");
		this.name = "DatasourceParseError";
		this.body = body;
	}
}

/**
 * Thrown by `Datasource#validate` when a response body fails Standard Schema
 * validation. Signals that the external data source returned a 2xx response
 * whose shape doesn't match the schema the caller declared, as distinct from
 * a transport-level failure (`DatasourceError`).
 */
export class DatasourceValidationError extends Error {
	readonly issues: readonly StandardSchemaV1.Issue[];

	constructor(issues: readonly StandardSchemaV1.Issue[]) {
		super(`Datasource response failed schema validation: ${formatIssues(issues)}`);
		this.name = "DatasourceValidationError";
		this.issues = issues;
	}
}
