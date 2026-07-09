/**
 * Boilerplate for extracting cursor-based pagination arguments from
 * `?cursor=...&limit=...` style query parameters, normalizing them into a shape
 * that can be passed directly to `model.paginate({ cursor, limit })`
 * (`SQLiteModel` and friends).
 *
 * Note that clamping `limit` to an upper bound is effectively a security
 * feature: letting a query like `?limit=1000000` through unvalidated would allow
 * an unbounded number of rows to be read in a single request (this also
 * directly affects Turso's rows-read billing and D1's response size limit).
 * This function always clamps to `maxLimit`, so callers can't accidentally
 * let an unbounded limit slip through.
 */
import type { Context, Env } from "hono";

export type ParsePaginationQueryOptions = {
	/** Default value used when the `limit` parameter is missing or invalid. */
	defaultLimit: number;
	/** Upper bound for `limit`. Values above this are clamped to it. */
	maxLimit: number;
	/** Name of the cursor query parameter. Defaults to `"cursor"`. */
	cursorParam?: string;
	/** Name of the limit query parameter. Defaults to `"limit"`. */
	limitParam?: string;
	/**
	 * Decodes the raw cursor string. Intended to be passed `decodeCursor`
	 * (the opaque cursor decoder) directly. When omitted, the raw string is
	 * returned as-is (apps with numeric primary keys must parse it themselves).
	 * Returning `null` is treated as "no cursor".
	 */
	decodeCursor?: (raw: string) => string | number | null;
};

/**
 * Extracts pagination arguments from a `Context`'s query parameters.
 *
 * `limit` is converted to an integer (fractional values are truncated with
 * `Math.trunc`). A missing, non-numeric, or non-positive value falls back to
 * `defaultLimit`; a value exceeding `maxLimit` is clamped to it. `cursor` is
 * `undefined` when missing; when `decodeCursor` is provided, its return value
 * is used (`null` is converted to `undefined`); otherwise the raw string is
 * returned as-is.
 *
 * The return value is shaped to be passed directly to
 * `model.paginate({ cursor, limit })`, but resolving the concrete type of
 * `cursor` (`string` vs `number`, depending on the app's primary key type) is
 * the caller's responsibility via `decodeCursor`.
 */
export const parsePaginationQuery = <E extends Env>(
	c: Context<E>,
	options: ParsePaginationQueryOptions,
): { cursor: string | number | undefined; limit: number } => {
	const {
		defaultLimit,
		maxLimit,
		cursorParam = "cursor",
		limitParam = "limit",
		decodeCursor,
	} = options;

	const rawLimit = c.req.query(limitParam);
	const parsedLimit = rawLimit === undefined ? Number.NaN : Number(rawLimit);
	const truncatedLimit = Math.trunc(parsedLimit);
	const limit =
		Number.isFinite(parsedLimit) && truncatedLimit > 0
			? Math.min(truncatedLimit, maxLimit)
			: defaultLimit;

	const rawCursor = c.req.query(cursorParam);
	const cursor =
		rawCursor === undefined
			? undefined
			: decodeCursor === undefined
				? rawCursor
				: (decodeCursor(rawCursor) ?? undefined);

	return { cursor, limit };
};
