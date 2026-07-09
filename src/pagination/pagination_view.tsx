/**
 * A pure, Hono-independent JSX component paired with the cursor-based pagination
 * result (`{ rows, nextCursor, hasMore }`) returned by `SQLiteModel#paginate`
 * (and the same-shaped `PgModel`/`MySqlModel`).
 *
 * Follows the same convention as `FormField` in `form/form_field.tsx`: the
 * Props type is exported, and the component itself is kept as a thin function
 * component that only receives its bound fields (here, `nextCursor`/`hasMore`),
 * with no dependency on Hono's `Context`.
 *
 * **Why only a "next" link and no page-number list**: the cursor approach (see
 * the `paginate` JSDoc) uses the primary key value of the last row on the
 * previous page as the starting point for the next page, so it has no way to
 * jump directly to an arbitrary page number (e.g. page 3) — that would require
 * information such as the total row count and each page's starting cursor,
 * which cursor pagination does not track. Getting the total count would
 * require a separate `count()` call, and going that far just to reproduce a
 * page-number UI would contradict the very decision to avoid offset
 * pagination in `paginate`. This view therefore only provides one-directional
 * "next" navigation.
 *
 * URL structure (e.g. query parameter names) is the app's responsibility, so
 * it is injected from the outside via `buildUrl`. Likewise, since i18n for the
 * link's label is the app's responsibility, `label` is required (following
 * oven's overall policy of not baking copy into the framework).
 */
export type PaginationViewProps = {
	/** The next page's cursor value, as returned by `paginate`. Meaningless when `hasMore` is `false`. */
	nextCursor: string | number | null;
	/** Whether a next page exists, as returned by `paginate`. */
	hasMore: boolean;
	/** Builds the next page URL from a cursor (URL structure is the app's responsibility). */
	buildUrl: (cursor: string | number) => string;
	/** Display text for the "next" link. Required since i18n is the app's responsibility. */
	label: string;
	/** `aria-label` for the `nav` element. Defaults to `"pagination"`. */
	navLabel?: string;
	/** Additional attributes passed through to the `nav` element. */
	attrs?: Record<string, string | number | boolean>;
};

/**
 * Renders the "next" link for cursor-based pagination. Renders nothing when
 * there is no next page (`hasMore` is `false`, or `nextCursor` is `null`).
 */
export const PaginationView = ({
	nextCursor,
	hasMore,
	buildUrl,
	label,
	navLabel = "pagination",
	attrs,
}: PaginationViewProps) => {
	if (!hasMore || nextCursor === null) return null;

	return (
		<nav aria-label={navLabel} {...attrs}>
			<a href={buildUrl(nextCursor)} rel="next">
				{label}
			</a>
		</nav>
	);
};
