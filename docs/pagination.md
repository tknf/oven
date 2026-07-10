# Pagination

## What / Why

Cursor-based pagination is a data-layer concern (`Model#paginate`, see
[Models § Cursor pagination with `paginate`](./models.md)) and a
request-layer concern at the same time: the data layer returns
`{ rows, nextCursor, hasMore }`, but something still has to turn an incoming
`?cursor=...&limit=...` query string into arguments `paginate` accepts, keep
the cursor value opaque as it travels through a URL, and render a "next page"
link. `@tknf/oven/pagination` covers exactly that request-side slice, split
into independent pieces:

- **`parsePaginationQuery`** — extracts and validates `cursor`/`limit` from a
  Hono `Context`'s query parameters, in a shape ready to hand straight to
  `model.paginate(...)`.
- **`encodeCursor`/`decodeCursor`** — an opaque, unsigned encoding for the raw
  primary-key value `paginate` returns as `nextCursor`, so the ID format
  (e.g. a Snowflake id's embedded timestamp) never leaks into a URL.
- **`PaginationView`** — a pure JSX component that renders a "next" link from
  a `paginate` result, with no dependency on Hono's `Context`.
- **`OffsetPaginationView`** — a pure JSX component that renders numbered page
  links from `Model#listPage`'s `page`/`pageCount` (plus an optional result
  count), for screens that page by number instead of cursor (see
  [Rendering numbered page links with `OffsetPaginationView`](#rendering-numbered-page-links-with-offsetpaginationview)
  below).

None of this replaces `Model#paginate`; it exists to sit on either side of it.

## Minimal example

```ts
// src/handlers/items_handler.ts
import { RouteHandler } from "@tknf/oven/routing";
import { decodeCursor, encodeCursor, parsePaginationQuery } from "@tknf/oven/pagination";
import { items } from "./items_model.js"; // your Model subclass

export class ItemsHandler extends RouteHandler {
  protected register() {
    this.get("/", async (c) => {
      const { cursor, limit } = parsePaginationQuery(c, {
        defaultLimit: 20,
        maxLimit: 100,
        decodeCursor,
      });

      const page = await items.paginate({ cursor, limit });

      return c.json({
        rows: page.rows,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
      });
    });
  }
}
```

## Common tasks

### Parsing a request into `paginate` arguments

```ts
const { cursor, limit } = parsePaginationQuery(c, {
  defaultLimit: 20,
  maxLimit: 100,
  // optional:
  cursorParam: "after", // defaults to "cursor"
  limitParam: "per_page", // defaults to "limit"
  decodeCursor, // defaults to returning the raw string as-is
});
```

`limit` is truncated to an integer (`Math.trunc`); a missing, non-numeric, or
non-positive value falls back to `defaultLimit`, and any value above
`maxLimit` is clamped to it — `parsePaginationQuery` always returns a value in
`(0, maxLimit]`, so a request can never force an unbounded read. `cursor` is
`undefined` when the parameter is missing; when `decodeCursor` is supplied,
its return value is used and a `null` result (a malformed cursor) is also
converted to `undefined`, so the caller doesn't have to special-case it
before passing `cursor` on to `paginate`.

### Round-tripping an opaque cursor through a URL

```ts
import { decodeCursor, encodeCursor } from "@tknf/oven/pagination";

const page = await items.paginate({ limit: 20 });
const nextUrl =
  page.hasMore && page.nextCursor !== null
    ? `/items?cursor=${encodeCursor(page.nextCursor)}`
    : null;

// on the next request:
const { cursor } = parsePaginationQuery(c, { defaultLimit: 20, maxLimit: 100, decodeCursor });
```

`encodeCursor` Base64URL-encodes the primary-key value with a type tag
(`"n:"` for `number`, `"s:"` for `string`), so `decodeCursor` can restore the
original type without the caller having to know it up front. `decodeCursor`
never throws on malformed input — it returns `null`, which
`parsePaginationQuery` treats the same as "no cursor" (i.e. the first page).

### Rendering a "next" link with `PaginationView`

```tsx
import { PaginationView } from "@tknf/oven/pagination";
import { pathFor } from "./routes.js"; // NamedRoutes#pathFor, see routing.md

<PaginationView
  nextCursor={page.nextCursor}
  hasMore={page.hasMore}
  buildUrl={(cursor) => `${pathFor("items.index")}?cursor=${encodeCursor(cursor)}`}
  label={t("pagination.next")}
/>;
```

`PaginationView` renders nothing (`null`) when `hasMore` is `false` or
`nextCursor` is `null`. It only ever renders a single forward link — there is
no page-number list, because cursor pagination has no way to jump to an
arbitrary page (that would require tracking each page's starting cursor and a
total row count, which `paginate` deliberately does not compute). `buildUrl`
receives the raw cursor value (`string | number`, not yet encoded), so
encoding it (with `encodeCursor`, if you use it) is the caller's job, matching
the URL-structure-is-the-app's-responsibility design also used by
`NamedRoutes`.

### Rendering numbered page links with `OffsetPaginationView`

`Model#listPage` (see
[Models § Offset pagination with `listPage`](./models.md#offset-pagination-with-listpage))
returns a bare row array, so `page`/`pageCount`/`total` are built by the
caller from a separate `count()` call:

```ts
const PAGE_SIZE = 20;
const page = Number(c.req.query("p") ?? "0") || 0;

const [rows, total] = await Promise.all([
  items.listPage({
    orderBy: [{ column: items.name, direction: "asc" }],
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  }),
  items.count(),
]);
const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
```

```tsx
import { OffsetPaginationView } from "@tknf/oven/pagination";
import { pathFor } from "./routes.js"; // NamedRoutes#pathFor, see routing.md

<OffsetPaginationView
  page={page}
  pageCount={pageCount}
  buildUrl={(p) => `${pathFor("items.index")}?p=${p}`}
  pageLabel={(n) => t("pagination.page", { n })}
  summary={t("pagination.total", { count: total })}
/>;
```

`OffsetPaginationView` renders `null` when there is nothing to show (a single
page and no `summary`). Otherwise it renders a page-number list — eliding long
runs down to the first 2, the last 2, and a window of 3 pages around the
current one — plus the optional `summary` text. `buildUrl` receives a 0-based
page index; page numbers are displayed 1-based, and the current page renders
as a `<span aria-current="page">` rather than a link. `AdminPanel`'s resource
and accounts-user list screens both use this component for their `?p=`
pagination.

## Gotchas / Security notes

- **`maxLimit` is a real security boundary, not a formatting nicety.**
  Letting `?limit=1000000` through unclamped would allow an unbounded number
  of rows to be read in a single request — this directly affects Turso's
  rows-read billing and D1's response size limit, so always pass a
  `maxLimit` you're comfortable with rather than relying on the default
  behavior of your database driver.
- **The cursor encoding is intentionally unsigned, not a security token.**
  Tampering with an encoded cursor only shifts the starting point of the
  `WHERE primaryKey > cursor` / `< cursor` condition; the set of rows a user
  can reach is no different from what they could already reach by paging
  through normally. Don't repurpose `encodeCursor`/`decodeCursor` as a
  general-purpose signed token — there is no signature to verify.
- **`paginate` uses keyset pagination (`WHERE pk > cursor ORDER BY pk`), not
  `OFFSET`** — an offset-based page number and a cursor are fundamentally
  different addressing schemes, and mixing them would silently break under
  concurrent inserts/deletes. `PaginationView` therefore only ever renders a
  "next" link. Jumping to an arbitrary page needs `Model#listPage`'s `OFFSET`
  instead, paired with `OffsetPaginationView`; prefer `paginate` for
  large-scale public feeds and reach for `listPage`/`OffsetPaginationView`
  only for bounded, internal-facing screens (e.g. an admin panel), where a
  deep `offset`'s scan-and-discard cost is acceptable.
- **A `decodeCursor` failure is fail-soft, not fail-closed.** A malformed or
  tampered cursor silently falls back to `undefined` (the first page) rather
  than throwing or returning a 400 — this is intentional (see the previous
  point on cursors not being a security boundary), but means a broken cursor
  in a bookmarked URL fails silently rather than surfacing an error to the
  user.

## See also

- [Models](./models.md) — `Model#paginate`, the data-side half of cursor
  pagination this module's query parsing and view are built around, and
  [`Model#listPage`](./models.md#offset-pagination-with-listpage), the
  offset-based counterpart `OffsetPaginationView` pairs with.
- [Routing](./routing.md) — `NamedRoutes#pathFor` for building the base path
  passed to `PaginationView`'s/`OffsetPaginationView`'s `buildUrl`.
- [View](./view.md) — where `PaginationView`/`OffsetPaginationView` fit into a
  page's JSX output.
- [Admin panel](./admin.md#sorting-and-paging-the-list-screen) — the resource
  and accounts-user list screens that use `OffsetPaginationView`.
