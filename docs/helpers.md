# Helpers

## What / Why

`@tknf/oven/helpers` is a small collection of independent, dependency-free
view-layer utilities — CSV assembly, currency/date-time/duration formatting,
and DOM id generation. None of them depend on Hono's `Context` or any other
part of the framework; each is a plain function you can call from a view,
a route handler, or a plain script alike. There is no single "helpers"
object or namespace — import only what you need.

## Minimal example

```ts
import { csvDocument, formatCurrency, formatDateTime } from "@tknf/oven/helpers";

const rows = [
  ["title", "price", "created_at"],
  ["Widget", formatCurrency(1200, { currency: "JPY", locale: "ja-JP" }), formatDateTime(Date.now(), { timeZone: "Asia/Tokyo" })],
];

const csv = csvDocument(rows);
```

## Common tasks

**Exporting a CSV response** (RFC4180-compliant; rows are joined with CRLF
and no trailing newline is added):

```ts
import { csvDocument } from "@tknf/oven/helpers";

app.get("/books.csv", (c) => {
  const rows = [
    ["code", "title"],
    ["ABC-123", "Introduction"],
  ];

  return c.body(csvDocument(rows), 200, {
    "Content-Type": "text/csv; charset=utf-8",
  });
});
```

When a column may contain user input that will be opened in Excel/Google
Sheets, pass `{ formulaGuard: true }` to neutralize formula injection (see
[Gotchas](#gotchas--security-notes) below):

```ts
csvDocument(rows, { formulaGuard: true });
```

**Formatting currency and date/time for display** (both wrap
`Intl.NumberFormat`/`Intl.DateTimeFormat` directly — no reimplementation of
locale/currency rules):

```ts
import { formatCurrency, formatDateTime } from "@tknf/oven/helpers";

formatCurrency(1200, { currency: "JPY", locale: "ja-JP" }); // "¥1,200"
formatDateTime(Date.now(), { timeZone: "Asia/Tokyo", locale: "ja-JP" });
```

**Displaying a playback position or an approximate duration:**

```ts
import { formatClockDuration, formatWordedDurationJa } from "@tknf/oven/helpers";

formatClockDuration(75); // "1:15"
formatClockDuration(3725); // "1:02:05"
formatWordedDurationJa(3725); // "1時間2分" (Japanese-only, see Gotchas)
```

**Generating a stable id for a Turbo Stream target / form element:**

```ts
import { domId } from "@tknf/oven/helpers";

domId("book", "42"); // "book_42"
domId("book"); // "new_book" (new-record case)
```

## Gotchas / Security notes

- **CSV formula injection is opt-in, not automatic.** `csvEscapeField`/
  `csvRow`/`csvDocument` only apply RFC4180 quoting (comma/quote/newline) by
  default. Pass `{ formulaGuard: true }` to also prefix fields starting
  with `=`, `+`, `-`, `@`, tab, or CR with a `'` — do this whenever a CSV
  containing user input may be opened in a spreadsheet app. Never enable it
  for CSV meant for machine-readable consumption, since it mutates the
  actual value.
- **`formatCurrency`/`formatDateTime` both require an explicit `currency`/
  `timeZone`** — the framework has no notion of an app-wide default
  currency or timezone, so there's no implicit fallback to guess wrong in
  production.
- **`formatWordedDurationJa` is hardcoded to Japanese** and intentionally
  bypasses the i18n catalog (`@tknf/oven/i18n`), since its output is app
  content rather than a framework-emitted message. Don't reach for it in a
  multilingual app; use `formatClockDuration` or a locale-aware
  `Intl.DurationFormat`-based formatter of your own instead.
- **`formatClockDuration`/`formatWordedDurationJa` treat negative or
  non-finite input as `0`** rather than throwing, so a bad playback
  position never breaks the screen — but this also means invalid input is
  silently displayed as zero rather than surfaced as an error.
- **`domId`'s `id` argument is percent-encoded** via `encodeURIComponent`,
  since ids are not guaranteed to be numeric strings (e.g. a free-text
  admin-entered label). The encoded output is safe to use directly as an
  HTML `id` attribute value.

## See also

- [Concepts](./concepts.md) — the framework's overall class-based idiom
  these helpers fit into.
- [Models](./models.md) — `IdGenerator`, the model layer's own id scheme
  (unrelated to `domId`, which only builds DOM target ids).
- [View](./view.md) — CSV export responses and pagination views are
  typically composed together.
- [Pagination](./pagination.md) — for paginating the rows passed into
  `csvDocument`.
