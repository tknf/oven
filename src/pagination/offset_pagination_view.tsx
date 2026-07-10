/**
 * A pure, Hono-independent JSX component paired with the offset/page-number
 * pagination metadata a caller builds around `Model#listPage` (all
 * `SQLiteModel`/`PgModel`/`MySqlModel` dialects): `listPage` itself returns a
 * bare row array, so `page`/`pageCount`/`total` are computed by the caller
 * from a separate `count()` call (see `Model#listPage` in `model/*`).
 *
 * Follows the same convention as `PaginationView` in `pagination_view.tsx`:
 * the Props type is exported, the component itself only receives its bound
 * fields, and neither URL structure nor copy is baked in — `buildUrl` and the
 * optional `pageLabel`/`summary` are all injected from the outside, since
 * routing and i18n are the app's responsibility.
 *
 * **Cursor vs. offset**: `PaginationView` pairs with `Model#paginate`'s
 * keyset cursor and only ever renders a single "next" link, because a cursor
 * has no way to jump to an arbitrary page. This component pairs with
 * `listPage`'s offset instead, which does support jumping to a page number at
 * the cost of a full scan-and-discard for deep pages — `listPage`'s own docs
 * recommend it for bounded, internal-facing listings (e.g. an admin panel)
 * rather than large-scale public feeds, where `paginate` remains the better
 * fit.
 */
export type OffsetPaginationViewProps = {
	/** Current page index, 0-based. */
	page: number;
	/** Total number of pages at the current page size. Always at least `1`. */
	pageCount: number;
	/** Builds one page's URL from a 0-based page index (URL structure is the app's responsibility). */
	buildUrl: (page: number) => string;
	/**
	 * `aria-label` for a page link, given the 1-based display number. Omitted
	 * entirely when not supplied, since i18n is the app's responsibility.
	 */
	pageLabel?: (n: number) => string;
	/** Optional result-count text, rendered as `<span class="result-count">`. */
	summary?: string;
	/** `aria-label` for the `nav` element. Defaults to `"pagination"`. */
	navLabel?: string;
	/** Additional attributes passed through to the `nav` element. */
	attrs?: Record<string, string | number | boolean>;
};

/** Marks an elided run of page numbers within `buildPageRange`'s result. */
const PAGE_RANGE_ELLIPSIS = "…";

/**
 * Elides a long page-number list down to the first 2, the last 2, and a
 * window of 3 pages on either side of the current page. Returns 0-based page
 * indexes interleaved with `PAGE_RANGE_ELLIPSIS` markers wherever a gap is
 * skipped.
 */
const buildPageRange = (
	page: number,
	pageCount: number,
): (number | typeof PAGE_RANGE_ELLIPSIS)[] => {
	const kept = new Set<number>();
	for (let i = 0; i < Math.min(2, pageCount); i++) kept.add(i);
	for (let i = Math.max(0, pageCount - 2); i < pageCount; i++) kept.add(i);
	for (let i = Math.max(0, page - 3); i <= Math.min(pageCount - 1, page + 3); i++) kept.add(i);

	const sorted = [...kept].sort((a, b) => a - b);
	const range: (number | typeof PAGE_RANGE_ELLIPSIS)[] = [];
	let previous: number | null = null;
	for (const current of sorted) {
		if (previous !== null && current - previous > 1) range.push(PAGE_RANGE_ELLIPSIS);
		range.push(current);
		previous = current;
	}
	return range;
};

/**
 * Renders numbered page links plus an optional result count. Renders nothing
 * when there is nothing to show: a single page (`pageCount <= 1`) and no
 * `summary`. The page-number list itself only renders when `pageCount > 1`;
 * the current page renders as `<span class="this-page" aria-current="page">`
 * rather than a link, and elided runs render as `<span class="ellipsis">`.
 */
export const OffsetPaginationView = ({
	page,
	pageCount,
	buildUrl,
	pageLabel,
	summary,
	navLabel = "pagination",
	attrs,
}: OffsetPaginationViewProps) => {
	if (pageCount <= 1 && summary === undefined) return null;

	return (
		<nav aria-label={navLabel} {...attrs}>
			{pageCount > 1 &&
				buildPageRange(page, pageCount).map((entry) => {
					if (entry === PAGE_RANGE_ELLIPSIS) {
						return <span class="ellipsis">{PAGE_RANGE_ELLIPSIS}</span>;
					}
					if (entry === page) {
						return (
							<span class="this-page" aria-current="page">
								{entry + 1}
							</span>
						);
					}
					return (
						<a href={buildUrl(entry)} aria-label={pageLabel ? pageLabel(entry + 1) : undefined}>
							{entry + 1}
						</a>
					);
				})}
			{summary !== undefined && <span class="result-count">{summary}</span>}
		</nav>
	);
};
