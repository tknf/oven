# Admin panel

## What / Why

`@tknf/oven/admin` is a unified admin panel in oven's explicit-registration
style: you mount it once, and each of its sections (resource CRUD, job
operations, settings, audit log) only renders and gets routes when you
inject the corresponding config. Nothing is auto-discovered.

`AdminPanel` is a `RouteHandler` subclass, mounted like any other handler
via `app.route("/admin", new AdminPanel({...}))`. It deliberately has no
built-in notion of "who's an admin" — authorization is a required
`authorize` callback you write yourself, typically by reusing your
existing `Guard`/`Policy` (see [Auth](./auth.md)). There's no client-side
JavaScript: every write action is a native `<form method="post">` plus a
303 redirect, and the panel's CSS is inlined server-side.

`AdminResource` is the abstract base class for one resource's CRUD screen
(one Drizzle table + one `Model`): you implement `key`/`label`/`model`/
`table`/`primaryKey`, and optionally `form()` to make it writable.

## Minimal example

```ts
// src/main.ts
import { Hono } from "hono";
import { AdminPanel } from "@tknf/oven/admin";
import { accountGuard } from "./lib/auth.js";

const app = new Hono();

app.route(
  "/admin",
  new AdminPanel({
    authorize: (c) => accountGuard.use(c).role === "admin",
  }),
);
```

With only `authorize` supplied, the panel renders a dashboard at
`GET /admin` and nothing else — every other section below is opt-in.

## Common tasks

### Adding a resource CRUD screen

Subclass `AdminResource` per table. `fieldsFromTable` derives sensible
`FieldDef`s (widget, required-ness, `<select>` options for enum columns,
etc.) from the Drizzle table's columns, so a simple form doesn't need to
restate them by hand:

```ts
// src/admin/publisher_resource.ts
import { z } from "zod";
import { AdminResource, fieldsFromTable } from "@tknf/oven/admin";
import { Form } from "@tknf/oven/form";
import type { FieldDef } from "@tknf/oven/form";
import { publishers } from "../db/schema.js";
import { publisherModel } from "../lib/models.js";

const publisherSchema = z.object({
  name: z.string().min(1),
  contactEmail: z.string().email(),
});

class PublisherForm extends Form<typeof publisherSchema> {
  protected schema() {
    return publisherSchema;
  }
  protected fields(): Record<string, FieldDef> {
    return fieldsFromTable(publishers);
  }
}

export class PublisherResource extends AdminResource {
  get key() {
    return "publishers";
  }
  get label() {
    return "Publishers";
  }
  get model() {
    return publisherModel;
  }
  get table() {
    return publishers;
  }
  get primaryKey() {
    return "id";
  }
  form() {
    return new PublisherForm();
  }
}
```

```ts
new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  resources: [new PublisherResource()],
});
```

Leaving `form()` unimplemented makes a resource view-only: no create/
edit/delete routes are registered for it (`AdminResource#canWrite()`
governs this). Override `listColumns()`/`exclude()` to control which
columns the list screen shows, and `searchColumns()` to enable a search
box (search terms are matched with an escaped `LIKE`, so `%`/`_` in user
input can't widen the match unexpectedly).

### Wiring CSRF protection

Inject a `Csrf` instance (from `@tknf/oven/security`) so every write
route under `/admin` is verified, and every generated form embeds the
hidden token input automatically:

```ts
import { Csrf } from "@tknf/oven/security";
import { sessionAccessor } from "./lib/session.js";

const csrf = new Csrf({ session: sessionAccessor.use });

new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  csrf,
});
```

### Adding job operations, settings, and audit log sections

Each section activates independently by injecting its config; the nav
only lists the sections you've wired:

```ts
new AdminPanel({
  authorize: (c) => accountGuard.use(c).role === "admin",
  jobs: { console: jobsConsole }, // e.g. an `SQLiteJobsConsole` — see the jobs guide
  settings: {
    featureFlags: { flags: featureFlags, names: ["new-checkout", "beta-search"] },
    maintenance: maintenanceMode, // from `@tknf/oven/security`
  },
  audit: { log: auditLog, actor: (c) => accountGuard.use(c).email },
});
```

`audit.actor` defaults to the literal string `"admin"` if omitted. Job
retry/delete, flag toggles, and maintenance toggles are all recorded to
`audit.log` automatically once `audit` is injected.

### Localizing the admin UI

The panel's own chrome (nav labels, headings, buttons, column headers —
not your resource/brand/flag names, which always render as-is) resolves
its language from `c.get("language")`, the same value `languageDetector`
sets on the context elsewhere in oven (see [i18n](./i18n.md)). Wiring
`languageDetector` upstream of the mount is the only step required —
there's no separate admin-specific i18n API to call:

```ts
import { languageDetector } from "hono/language";

app.use(languageDetector({ supportedLanguages: ["en", "ja"], fallbackLanguage: "en" }));
app.route("/admin", new AdminPanel({ authorize: (c) => accountGuard.use(c).role === "admin" }));
```

Without `languageDetector` applied (or for an unsupported/undetected
language), the panel falls back to English.

## Gotchas / Security notes

- **CSRF is not enforced unless you inject `csrf`.** This mirrors the
  general CSRF guidance in [Security](./security.md) and
  [`SECURITY.md`](../SECURITY.md): wire CSRF verification into the
  panel's write routes yourself, either via the `csrf` option shown above
  or by verifying upstream. Without it, the panel logs a one-time
  `console.warn` on the first unsafe-method request, but still serves it
  — it does not fail closed on its own.
- **`authorize` is mandatory and the panel assumes nothing about roles.**
  There's no default "is this user an admin" check; a misconfigured
  `authorize` (e.g. one that always returns `true`) is the same as
  leaving `/admin` unauthenticated.
- **Resources are structural, not tied to a specific dialect.**
  `AdminResource#model` only needs to satisfy the `AdminModel` shape
  (`paginate`/`retrieve`/`create`/`update`/`delete`), so `SQLiteModel`,
  `PgModel`, and `MySqlModel` subclasses all work without adapters.
- **Primary keys are assumed to be strings.** Number-PK tables aren't
  supported by `AdminResource` today.
- **Column allowlisting on write is your form's job, not the panel's.**
  `AdminPanel` passes a successful `Form#validate()` result straight to
  `model.create`/`model.update` (stripping only the primary-key column on
  update, so the URL's `id` can't be overwritten); your `Form#schema()`
  is what determines which fields are actually accepted.

## See also

- [Auth](./auth.md) — `Guard`/`Policy`, the building blocks typically
  reused inside `authorize`.
- [Security](./security.md) — `Csrf`, `MaintenanceMode`, and the rest of
  the hardening primitives the panel's options accept.
- [Forms](./forms.md) — the `Form`/`FieldDef` machinery `AdminResource`
  builds its create/edit screens on top of.
- [i18n](./i18n.md) — `languageDetector` wiring and how the translation
  fallback chain behaves.
