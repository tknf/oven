# Datasource

## What / Why

`@tknf/oven/datasource` is a thin abstract base over `fetch` for talking to an
external HTTP/REST API using the same retrieve/list/create/update/delete
vocabulary as [Model](./models.md). The key difference from `Model`: a
`Datasource` talks to a system outside the application's own database, so
every response body is **untrusted external data** and must be validated with
a [Standard Schema](https://standardschema.dev) before it's handed back to the
caller — the same sync/async validation pattern [Form](./forms.md) uses.

There are two layers:

- **`Datasource`** — the low-level base. It owns `baseUrl` resolution, header
  merging, request timeout, and JSON (de)serialization, and exposes a single
  protected `request(path, options)` method plus a protected `validate(schema,
value)` helper.
- **`RestDatasource<T>`** — a concrete convention on top of `Datasource` for a
  single REST resource (e.g. `/users`), giving it `retrieve`/`list`/`create`/
  `update`/`delete` methods. Subclasses implement `resourcePath` and `schema`;
  everything else is derived.

`schema` is a plain [Standard Schema](https://standardschema.dev) value — pick
whichever compliant library you already use (zod, valibot, ...); the package
itself only depends on `@standard-schema/spec`.

## Minimal example

```ts
// src/datasources/users_source.ts
import { z } from "zod";
import { RestDatasource } from "@tknf/oven/datasource";

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
type User = z.infer<typeof userSchema>;

export class UsersSource extends RestDatasource<User> {
  protected get resourcePath() {
    return "/users";
  }
  protected get schema() {
    return userSchema;
  }
}
```

```ts
const users = new UsersSource({
  baseUrl: "https://api.example.com/v1",
  headers: { authorization: `Bearer ${apiToken}` },
});

const user = await users.retrieve("42"); // User | undefined (undefined on 404)
const all = await users.list(); // User[]
const created = await users.create({ name: "Ada", email: "ada@example.com" }); // User
```

## Common tasks

### Fetching one entity, or an unbounded list

```ts
await users.retrieve(42); // GET /users/42 — undefined if the response is 404
await users.list(); // GET /users — validates each item against `schema`
```

`retrieve` mirrors `Model#retrieve`: a `404` response is treated as an
expected "not found" outcome and resolves to `undefined` rather than
throwing. Any other non-2xx status still throws `DatasourceError`.

### Unwrapping an enveloped list response

`list`'s default `toArray` requires the raw response itself to be a JSON
array. Override it when the API wraps the list in an envelope such as
`{ data: [...] }`:

```ts
export class UsersSource extends RestDatasource<User> {
  // ...
  protected toArray(raw: unknown) {
    return (raw as { data: unknown[] }).data;
  }
}
```

`toArray` is a lightweight fit for a list that's only thinly wrapped around
a bare array — it discards the wrapper entirely, so a cast is unavoidable
inside it. If the envelope also carries metadata you need (total count,
pagination cursors, ...), don't fight `toArray`/`list` for it — use the
schema-per-envelope approach in "Enveloped or metadata-carrying responses"
below instead, which returns the envelope's inferred type with no cast.

### Create / update / delete

```ts
await users.create({ name: "Ada", email: "ada@example.com" }); // POST /users
await users.update(42, { name: "Ada Lovelace" }); // PATCH /users/42
await users.delete(42); // DELETE /users/42
```

`create`/`update` validate the response against `schema`; `delete` doesn't
parse a response body at all.

### Query parameters and per-call headers

Every `RestDatasource` method takes an optional `{ query?, headers? }` as its
last argument:

```ts
await users.list({ query: { status: "active" }, headers: { "x-request-id": id } });
```

`query` accepts a plain object (`undefined` values are skipped) or a
`URLSearchParams`. Per-call `headers` are merged over the config-level
`headers` passed to the constructor.

### `baseUrl` with a path prefix

`baseUrl` is resolved with plain string concatenation, not `new URL(path,
baseUrl)` — a `baseUrl` such as `"https://api.example.com/v1"` keeps its
`/v1` prefix on every request instead of it being silently dropped whenever
`resourcePath` starts with `/`.

### Enveloped or metadata-carrying responses

Some list APIs don't return a bare array or a `{ data: [...] }` wrapper
around one — they return an envelope that carries pagination metadata
alongside the items, e.g. `{ items: [...], totalCount, offset, limit }`.
Neither `RestDatasource#list` (which resolves to `T[]`) nor `toArray`
(which discards everything but the array) can hand that metadata back to the
caller.

For this shape, declare a second Standard Schema for the envelope — on top
of the entity schema `RestDatasource` already requires — and call
`this.request` directly from a custom method. Because `request`'s `schema`
overload infers its return type from the schema itself, the method's return
value is the envelope's inferred type with **no cast** needed:

```ts
import { z } from "zod";
import { RestDatasource } from "@tknf/oven/datasource";

const userSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().email(),
});
type User = z.infer<typeof userSchema>;

const userPageSchema = z.object({
  items: z.array(userSchema),
  totalCount: z.number(),
  offset: z.number(),
  limit: z.number(),
});

export class UsersSource extends RestDatasource<User> {
  protected get resourcePath() {
    return "/users";
  }
  protected get schema() {
    return userSchema;
  }

  /** Fetches one page of users along with the total count, offset, and limit. */
  async page(query: { offset?: number; limit?: number }) {
    return this.request(this.resourcePath, { query, schema: userPageSchema });
  }
}
```

```ts
const { items, totalCount } = await users.page({ offset: 0, limit: 20 });
```

If the upstream API also splits reads and writes across different hosts,
create a second `Datasource`/`RestDatasource` instance pointed at the write
`baseUrl` rather than trying to make one instance serve both.

### Defining custom methods: the base's constraints, your vocabulary

`RestDatasource`'s `retrieve`/`list`/`create`/`update`/`delete` are a
convenient default for a resource that fits plain REST — they are not the
only way to use `Datasource`. The base `Datasource` class is what actually
owns the constraints (`baseUrl` resolution, default headers, `timeoutMs`,
Standard Schema validation via `validate`); any subclass can call its
protected `request(path, options)` to define an arbitrary, fully typed
method for any path, method, and schema. When the REST vocabulary doesn't
fit — a custom action, a non-resource endpoint, or the enveloped-list case
above — write the method yourself instead of forcing it into `retrieve`/
`list`/.../`delete`:

```ts
export class UsersSource extends RestDatasource<User> {
  // ...
  async activate(id: string) {
    return this.request(`/users/${id}/activate`, { method: "POST", schema: this.schema });
  }
}
```

`request(path, options)` takes `{ method?, query?, body?, headers?, schema? }`
(`method` defaults to `GET`). When `schema` is given, the parsed response is
validated and the resolved type is returned; without it, the parsed-but-
unvalidated JSON body is returned.

Nothing requires going through `RestDatasource` at all: a data source whose
endpoints don't map to one resource can extend `Datasource` directly and
define every method as a thin `request` call:

```ts
import { Datasource } from "@tknf/oven/datasource";

export class Cms extends Datasource {
  blogs = (query?: { offset?: number; limit?: number }) =>
    this.request("/blogs", { query, schema: blogListSchema });

  blog = (id: string) => this.request(`/blogs/${id}`, { schema: blogSchema });
}
```

### Request timeout

```ts
new UsersSource({ baseUrl: "https://api.example.com/v1", timeoutMs: 5000 });
```

`timeoutMs` applies to every request issued by the instance. There is no
timeout by default.

## Gotchas / Security notes

- **A failed schema validation throws `DatasourceValidationError`**, not
  `DatasourceError` — it carries `issues` (the raw Standard Schema issues) and
  is raised for a 2xx response whose body doesn't match `schema`, distinct
  from a transport-level failure.
- **A non-2xx response throws `DatasourceError`** with `status`, `method`,
  `url`, and `body`. `body` is the response text truncated to a maximum of
  8192 characters (the `message`'s own preview of the body is truncated
  shorter, to 500 characters). `retrieve`'s 404-to-`undefined` behavior only
  swallows `404`; every other non-2xx status (`401`, `500`, ...) still
  propagates as `DatasourceError`. Since `body` may echo back sensitive
  details from the upstream response, be careful about forwarding it verbatim
  to a log or monitoring pipeline.
- **A 2xx response whose body isn't valid JSON throws `DatasourceParseError`**,
  carrying the unparsed response text (also truncated to 8192 characters) on
  `body`.
- **`list`'s default `toArray` assumes a bare JSON array.** Calling `list()`
  against an enveloped response without overriding `toArray` throws — see
  Common tasks above.
- **Cloudflare Workers' `fetch` has no default timeout.** Set `timeoutMs` in
  production so a slow or hanging upstream can't stall a request indefinitely.
- **Always pass a `schema`.** Response bodies are untrusted external data —
  skipping `schema` (calling `request` without it) returns the parsed JSON
  as-is with no shape guarantee.

## See also

- [Concepts](./concepts.md) — the design principles and the full subpath
  export map.
- [Models](./models.md) — the same retrieve/list/create/update vocabulary for
  the application's own database, where input is already trusted.
- [Forms](./forms.md) — the same Standard Schema validation pattern applied
  to inbound request input instead of outbound external responses.
