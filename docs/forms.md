# Forms

## What / Why

`@tknf/oven/form` bundles two concerns that server-rendered form handling
otherwise scatters across a handler: **validation** and **the default
view**. Validation is entirely delegated to
[Standard Schema](https://standardschema.dev) — oven doesn't reimplement
schema validation, so you're free to write your schema with zod, valibot,
or any other Standard Schema-compliant library. What oven adds on top is
the `Form` abstract base class: subclasses implement `schema()` (validation)
and `fields()` (label/hint/widget metadata Standard Schema itself has no
concept of), and `Form#bind()` combines a validation result with those
field declarations into a `FormBinding` that a view can render directly.

`File` upload content (size, MIME type) isn't something Standard Schema
validates either, so `@tknf/oven/form` separately provides
`validateUploadedFile`/`sniffMimeType` as plain functions for that axis.

## Minimal example

```ts
// src/forms/redeem_code_form.ts
import { z } from "zod";
import { Form } from "@tknf/oven/form";
import type { FieldDef } from "@tknf/oven/form";

const redeemCodeSchema = z.object({
  code: z.string().min(1, "Please enter a code."),
});

export class RedeemCodeForm extends Form<typeof redeemCodeSchema, "code"> {
  protected schema() {
    return redeemCodeSchema;
  }
  protected fields(): Record<"code", FieldDef> {
    return {
      code: { label: "Serial code", hint: "Enter the code printed in your book." },
    };
  }
}
```

```ts
// inside a handler's register()
this.post("/redeem", async (c) => {
  const form = new RedeemCodeForm();
  const result = await form.validate(await c.req.parseBody());

  if (!result.ok) {
    const binding = form.bind(result);
    return c.render(<RedeemCodePage binding={binding} />, { title: "Redeem" });
  }

  // result.value is the schema's validated/transformed output.
  return c.redirect("/redeemed", 303); // 303 PRG on success
});
```

## Common tasks

### Re-rendering the same response on validation failure (422)

A failed `validate()` result already carries the trimmed `values` alongside
`errors`, so `form.bind(result)` (where `result.ok === false`) is enough to
rebuild the view with the user's own input and per-field error messages:

```ts
const result = await form.validate(await c.req.parseBody());
if (!result.ok) {
  const binding = form.bind(result); // { errors, values } from the failed result
  c.status(422);
  return c.render(<FormPage binding={binding} />, { title: "..." });
}
```

### Flashing errors across a redirect

When the app redirects instead of re-rendering directly (e.g. after a
cross-handler orchestration step), push the failure into the session and
pick it back up in the destination GET handler:

```ts
import { flashFormErrors, consumeFlashedFormState } from "@tknf/oven/form";

// In the POST handler, on failure:
flashFormErrors(session, result); // result.ok === false
return c.redirect("/form", 303);

// In the GET handler for /form:
const flashed = consumeFlashedFormState(session); // null on a normal GET
const binding = form.bind(flashed ?? undefined);
```

`File` values can't be flashed (browsers can't repopulate
`input[type=file]` from JS), so `flashFormErrors` drops them via
`toOldFormInput` internally.

### Pre-filling an edit form from a DB row

```ts
const item = await items.retrieve(id);
const binding = form.bind({ values: form.toInput(item) });
```

### Rendering fields with the default view helpers

`FormView` (in `@tknf/oven/form`, a JSX component) renders a whole `<form>`
— CSRF hidden field, hidden fields, whole-form errors, then visible fields
— from a `FormBinding` alone, without hand-wiring each `<input>`:

```tsx
import { FormView } from "@tknf/oven/form";
import type { FormBinding } from "@tknf/oven/form";

const RedeemCodePage = ({ binding, csrfToken }: { binding: FormBinding<"code">; csrfToken: string }) => (
  <FormView form={binding} action="/redeem" csrfToken={csrfToken}>
    <button type="submit">Redeem</button>
  </FormView>
);
```

### Validating an uploaded file's size and MIME type

```ts
import { validateUploadedFile, sniffMimeType } from "@tknf/oven/form";

const body = await c.req.parseBody();
const validation = validateUploadedFile(body.cover, {
  maxSizeBytes: 5 * 1024 * 1024,
  allowedMimeTypes: ["image/png", "image/jpeg"],
});

if (!validation.ok) {
  // validation.reason: "not-a-file" | "too-large" | "unsupported-type"
  // validation.message is an English default; localize per-locale error
  // copy with localizeUploadedFileError (see the i18n guide).
}
```

## Gotchas / Security notes

- **String values are trimmed automatically** inside `validate()` (array
  values element-by-element; `File` values untouched) — don't trim inputs
  yourself before calling `validate`.
- **`file.type` is client-declared and spoofable.** `validateUploadedFile`'s
  `allowedMimeTypes` check only looks at the browser-reported MIME type.
  Combine it with the async `sniffMimeType` (magic-byte detection) when a
  stronger, content-based guarantee is required.
- **A Standard Schema issue with no `path`** (a whole-object error, e.g. "this
  email is already registered") is collapsed into the fixed field name
  `"base"` (`FORM_BASE_ERROR_FIELD`) rather than being dropped — render it
  with `binding.baseErrors()`, not per-field lookups.
- **Multiple forms of the same shape on one page** need `bind({ prefix })`
  / `validate(input, { prefix })` with the same `prefix` on both sides, so
  rendered `name`/`id` attributes don't collide and submitted input is
  correctly matched back to the right form.
- **Deeper Standard Schema issue paths are flattened to their first
  segment** (`toFormErrors`) — a nested path like `["address", "city"]`
  becomes the field `"address"`, since a form field corresponds to a single
  HTML `name`.

## See also

- [Concepts](./concepts.md) — how `Form` fits the same "abstract base class
  + subclass implements the specific bits" idiom used throughout oven.
- [Models](./models.md) — where validated form output typically ends up
  (models trust already-normalized input; they don't validate it themselves).
