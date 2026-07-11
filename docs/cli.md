# CLI

## What / Why

`@tknf/oven` ships a small `oven` bin (`oven generate`, aliased `oven g`) that
scaffolds a starting-point file for each of oven's class-based building
blocks. It is a developer-machine-only tool: it never runs at request time and
is not imported from `@tknf/oven` itself, so it's not a subpath export like
the rest of this documentation — install the package and the `oven` command
becomes available wherever your package manager puts installed bins on
`PATH`. It parses argv by hand (no CLI framework dependency) and only ever
writes one new file per invocation; nothing it generates is wired into your
app automatically — add the `import`/registration yourself (consistent with
oven's "no magic" principle, see [Concepts](./concepts.md)).

## Usage

```
oven generate <type> <Name> [--dir <path>] [--dialect sqlite|pg|mysql] [--force]
oven g <type> <Name> ...        # alias for generate

oven --help / oven -h           # show usage
oven --version / oven -v        # print the installed package version
```

`<type>` is one of `handler`, `model`, `form`, `job`, `policy`, `view`,
`seed`, `admin-resource`. `<Name>` may be `PascalCase`, `snake_case`,
`kebab-case`, or plain lowercase — it's normalized both ways as needed (e.g.
`book-review` and `book_review` both become the class name `BookReview...`
and the file name `book_review_....ts`). Passing a name that already ends in
the type's class suffix (e.g. `BooksHandler` for `handler`) does not double
it.

- **`--dir <path>`** — overrides the type's conventional output directory
  (see the reference below). Example:
  `oven generate handler books --dir app/handlers` writes
  `app/handlers/books_handler.ts` instead of the default
  `src/handlers/books_handler.ts`.
- **`--dialect sqlite|pg|mysql`** — selects the Drizzle dialect for the
  `model` template only (default `sqlite`). Passing it for any other type is
  rejected with an explicit error
  (`--dialect only applies to the model template, not "<type>"`), both at
  the CLI argument-parsing layer and inside the underlying `planGeneration`
  function.
- **`--force`** — overwrites a file that already exists at the target path.
  Without it, generation fails with
  `File already exists: <path> (use --force to overwrite)`.

An unrecognized `--` flag (anything not in `--dir`/`--dialect`/`--force`) is
rejected up front with the usage text, before any file is planned or written.

## Generator reference

Each entry shows the default output path and what the generated file
exports, given the example invocation.

- **`handler`** — `oven generate handler books` → `src/handlers/books_handler.ts`:
  a `BooksHandler extends RouteHandler` with an empty `register()` stub. See
  [Routing](./routing.md).
- **`model`** — `oven generate model book --dialect pg` → `src/models/book_model.ts`:
  a Drizzle table (`book`, dialect-specific column builders) plus
  `BookModel extends PgModel<...>` (or `SQLiteModel`/`MySqlModel` for the
  other dialects; `sqlite` is the default when `--dialect` is omitted). See
  [Models](./models.md).
- **`form`** — `oven generate form book` → `src/forms/book_form.ts`:
  a `BookForm extends Form<...>` with `schema()`/`fields()` TODO stubs. See
  [Forms](./forms.md).
- **`job`** — `oven generate job SendWelcomeMail` → `src/jobs/send_welcome_mail_job.ts`:
  a `SendWelcomeMailJobPayload` type, `SendWelcomeMailJob extends Job<SendWelcomeMailJobPayload>`,
  and `readonly name = "send_welcome_mail"`. See [Jobs](./jobs.md).
- **`policy`** — `oven generate policy book` → `src/policies/book_policy.ts`:
  a `BookPolicy extends Policy` with a commented example ability. See
  [Authentication](./auth.md).
- **`view`** — `oven generate view book` → `src/views/book_view.ts`:
  a `BookView extends View` with an `html(c: Context)` stub. See
  [View](./view.md).
- **`seed`** — `oven generate seed demo_books` → `src/seeds/demo_books_seed.ts`:
  just an exported `runDemoBooksSeed` async function — oven has no seed
  execution runtime, so running it (a script, a `vp exec tsx` call, or a test
  setup import) is left to your app.
- **`admin-resource`** — `oven generate admin-resource book` → `src/admin/book_resource.ts`:
  a `BookResource extends AdminResource` that takes its `Model` instance and
  Drizzle table via the constructor (fill in the `key`/`label`/`primaryKey`
  TODOs, then register with `resources: [new BookResource(bookModel, book)]`).
  `--dialect` is rejected for this type — `AdminResource`'s `AdminModel`
  contract is dialect-agnostic, so the template has no dialect branch. See
  [Admin panel](./admin.md#adding-a-resource-crud-screen).

## Gotchas

- **Nothing generated is auto-registered.** A generated handler isn't
  mounted with `app.route(...)`, a generated job isn't added to a
  `JobRegistry`, a generated resource isn't added to `AdminPanel`'s
  `resources` — you wire each one in yourself, the same as hand-written code.
- **`--dialect` only ever applies to `model`.** Every other type rejects it,
  including `admin-resource` even though it also touches the database layer
  (its `AdminModel` contract is dialect-agnostic by design).
- **Generated files are meant to be edited, not run as-is.** Every template
  leaves `TODO` comments (an unimplemented `schema()` throws, a bare `"TODO"`
  response body, etc.) — they exist to type-check standalone, not to be
  production-ready out of the box.
- **The CLI is a dev-machine tool only.** It uses `node:fs`/`node:path`/
  `node:process` directly and is never imported from the runtime core, so
  none of the backend-agnostic constraints that apply to `src/**` apply to it.

## See also

- [Concepts](./concepts.md) — the class-based idiom every generated file
  follows (abstract base + inheritance, no auto-discovery).
- [Admin panel](./admin.md) — the `AdminResource` shape the `admin-resource`
  template scaffolds, and how to register the generated resource.
