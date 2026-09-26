# CLI

## What / Why

`@tknf/oven` ships a small `oven` bin (`oven generate`, aliased `oven g`) that
scaffolds a starting-point file inside a domain directory
(`src/domains/<domain>/`, see
[Application structure](./getting-started.md#application-structure)). It is a
developer-machine-only tool: it never runs at request time and is not imported
from `@tknf/oven` itself, so it's not a subpath export like the rest of this
documentation — install the package and the `oven` command becomes available
wherever your package manager puts installed bins on `PATH`. It parses argv by
hand (no CLI framework dependency) and only ever writes one new file per
invocation; nothing it generates is wired into your app automatically — add
the `import`/mounting yourself (consistent with oven's "no magic" principle,
see [Concepts](./concepts.md)).

## Usage

```
oven generate <type> <domain> [name] [--dir <path>] [--dialect sqlite|pg|mysql] [--force]
oven g <type> <domain> [name] ...   # alias for generate

oven --help / oven -h               # show usage
oven --version / oven -v            # print the installed package version
```

`<type>` is one of `routes`, `schema`, `model`, `form`, `policy`, `view`,
`job`, `admin`. `<domain>` names the directory under `src/domains/` and is
normalized to snake_case (`BookReviews` → `src/domains/book_reviews/`).
`[name]` is the entity name used for class and table names and defaults to
`<domain>`; `view` and `job` require it, because it is also their file name.
Names may be `PascalCase`, `snake_case`, `kebab-case`, or plain lowercase, and
a name that already ends in the type's class suffix (e.g. `BookModel` for
`model`) does not get it twice.

- **`--dir <path>`** — overrides the output directory. Example:
  `oven generate routes books --dir app/books` writes `app/books/routes.ts`
  instead of `src/domains/books/routes.ts`.
- **`--dialect sqlite|pg|mysql`** — selects the Drizzle dialect for the
  `schema` and `model` templates (default `sqlite`). Passing it for any other
  type is rejected with an explicit error
  (`--dialect only applies to the schema and model templates, not "<type>"`),
  both at the CLI argument-parsing layer and inside the underlying
  `planGeneration` function.
- **`--force`** — overwrites a file that already exists at the target path.
  Without it, generation fails with
  `File already exists: <path> (use --force to overwrite)`.

An unrecognized `--` flag (anything not in `--dir`/`--dialect`/`--force`) is
rejected up front with the usage text, before any file is planned or written.

## Generator reference

Each entry shows the default output path and what the generated file
exports, given the example invocation. The generator does not create
`src/main.ts`, `src/db/schema.ts`, `src/db/client.ts`, `db/config.ts`,
migrations, or seed scripts.

- **`routes`** — `oven generate routes books` → `src/domains/books/routes.ts`:
  `export const booksRoutes = new Hono().get("/", ...)`, a sub-app written as a
  method chain. Mount it from `src/main.ts` with
  `app.route("/books", booksRoutes)`. See [Routing](./routing.md).
- **`schema`** — `oven generate schema books book --dialect pg` →
  `src/domains/books/schema.ts`: the Drizzle table `book` with
  dialect-specific column builders and nothing else. Re-export it from
  `src/db/schema.ts`. See [Models](./models.md).
- **`model`** — `oven generate model books book --dialect pg` →
  `src/domains/books/model.ts`: `BookModel extends PgModel<...>` (or
  `SQLiteModel`/`MySqlModel`), importing `book` from `./schema.js`. Generate
  the schema first with the same name and dialect. See [Models](./models.md).
- **`form`** — `oven generate form books book` → `src/domains/books/form.ts`:
  a `BookForm extends Form<...>` with `schema()`/`fields()` TODO stubs. See
  [Forms](./forms.md).
- **`policy`** — `oven generate policy books book` →
  `src/domains/books/policy.ts`: a `BookPolicy extends Policy` with a
  commented example ability. See [Authentication](./auth.md).
- **`view`** — `oven generate view books list` →
  `src/domains/books/views/list.tsx`: a `BooksListView extends View` whose
  `html(c: Context)` returns a JSX stub. See [View](./view.md).
- **`job`** — `oven generate job books import_books` →
  `src/domains/books/jobs/import_books.ts`: an `ImportBooksJobPayload` type,
  `ImportBooksJob extends Job<ImportBooksJobPayload>`, and
  `readonly name = "import_books"`. See [Jobs](./jobs.md).
- **`admin`** — `oven generate admin books book` → `src/domains/books/admin.ts`:
  a `BookResource extends AdminResource` that takes its `Model` instance and
  Drizzle table via the constructor (fill in the `key`/`label`/`primaryKey`
  TODOs, then register with `resources: [new BookResource(bookModel, book)]`).
  `--dialect` is rejected for this type — `AdminResource`'s `AdminModel`
  contract is dialect-agnostic, so the template has no dialect branch. See
  [Admin panel](./admin.md#adding-a-resource-crud-screen).

## Gotchas

- **Nothing generated is auto-registered.** Generated routes aren't
  mounted with `app.route(...)`, a generated schema isn't re-exported from
  `src/db/schema.ts`, a generated job isn't added to a `JobRegistry`, a
  generated resource isn't added to `AdminPanel`'s `resources` — you wire
  each one in yourself, the same as hand-written code.
- **One generated entity per domain file.** `schema`, `model`, `form`,
  `policy`, and `admin` always write the domain's single `<type>.ts`, so a
  second entity for the same domain would target an existing file (refused
  without `--force`; replaced with it). `--dir` changes only the directory,
  not the file name. Add the second entity to the existing file by hand, or
  split the role into a directory (e.g. `models/book.ts`, `models/author.ts`)
  by hand.
- **`--dialect` only applies to `schema` and `model`.** Every other type
  rejects it, including `admin` even though it also touches the database
  layer (its `AdminModel` contract is dialect-agnostic by design).
- **The view template is a `.tsx` file.** It returns JSX, so the app's
  `tsconfig.json` needs `"jsx": "react-jsx"` and `"jsxImportSource": "hono/jsx"`.
- **The form template imports `@standard-schema/spec`.** Its
  `StandardSchemaV1` type comes from that package, which oven depends on but
  does not re-export; add `@standard-schema/spec` to the app's dependencies
  if the package manager does not hoist it.
- **Generated files are meant to be edited, not run as-is.** Every template
  leaves `TODO` comments (an unimplemented `schema()` throws, a bare `"TODO"`
  response body, etc.) — they exist to type-check standalone, not to be
  production-ready out of the box.
- **The CLI is a dev-machine tool only.** It uses `node:fs`/`node:path`/
  `node:process` directly and is never imported from the runtime core, so
  none of the backend-agnostic constraints that apply to `src/**` apply to it.

## See also

- [Getting started](./getting-started.md#application-structure) — the domain
  layout the generator writes into.
- [Admin panel](./admin.md) — the `AdminResource` shape the `admin` template
  scaffolds, and how to register the generated resource.
