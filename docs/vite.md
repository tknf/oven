# Vite

## What / Why

`@tknf/oven/vite` bridges Hono/JSX SSR and a Vite frontend build, following
an "explicit declaration + manifest resolution + fail-closed" approach
instead of automatic entry discovery (no AST traversal of your sources
looking for imports). You explicitly name an entry
(e.g. `<assets.Script name="src/client.ts" />`); in development that name is
served as-is as a source path, and in production it is resolved against
Vite's `manifest.json`. Referencing an entry name that doesn't exist throws
`ViteEntryNotFoundError` rather than silently emitting a broken URL.

The module has no hard dependency on the `vite` package itself — `parseViteManifest`
validates the manifest JSON against a small, self-contained structural type
(`ViteManifest`/`ViteManifestChunk`) instead of importing Vite's own
`ManifestChunk` type. It also never sniffs `import.meta.env` to decide
dev vs. prod; the caller passes `mode` explicitly, which is what lets the
same `ViteAssets` API work identically whether your app runs on Cloudflare
Workers or Node (see [Deployment](./deployment.md), which covers where the
manifest read itself happens on each platform).

## Minimal example

```tsx
// src/lib/assets.ts
import { ViteAssets } from "@tknf/oven/vite";

export const assets = new ViteAssets({ mode: "development" });
```

```tsx
// src/layouts/app_layout.tsx
import type { FC } from "hono/jsx";
import { assets } from "../lib/assets.js";

export const AppLayout: FC = ({ children }) => (
  <html lang="en">
    <head>
      <assets.ViteClient />
      <assets.Script name="src/client.ts" />
    </head>
    <body>{children}</body>
  </html>
);
```

`assets.ViteClient` injects Vite's dev client (`/@vite/client`) only in
development, and `assets.Script` emits a `type="module"` script pointing at
the raw source path — no manifest is consulted yet.

## Common tasks

### Wiring `ViteAssets` for development vs. production

```ts
new ViteAssets({ mode: "development", base: "/" });
```

```ts
import { readFile } from "node:fs/promises";
import { ViteAssets, parseViteManifest } from "@tknf/oven/vite";

const manifest = parseViteManifest(
  await readFile("./dist/client/.vite/manifest.json", "utf-8"),
);

const assets = new ViteAssets({ mode: "production", manifest, base: "/" });
```

`ViteAssetsOptions` is `{ mode: "development" | "production"; manifest?:
ViteManifest; base?: string }`. `manifest` is required when `mode` is
`"production"` — the constructor throws immediately if it's missing, rather
than deferring the failure to the first render. `base` prefixes every
resolved path (both source paths in development and manifest-resolved paths
in production) and defaults to `"/"`; it's joined without ever producing a
double slash, so `base: "/static/"` and an entry path starting with `/`
compose cleanly. `parseViteManifest` takes the manifest as a **raw JSON
string**, not an already-parsed object — it does the `JSON.parse` itself so
it can validate the result's shape (a plain object of `ViteManifestChunk`s)
before returning it, throwing `ViteManifestParseError` on anything else
(fail-closed, per the project rule that `JSON.parse` output must never be
passed through untyped).

### Rendering scripts, stylesheets, and images

```tsx
<assets.Script name="src/client.ts" />
<assets.Script name="src/admin.ts" preload={false} />
<assets.Link name="src/style.css" />
<assets.Img name="src/logo.png" alt="Logo" />
```

In production, `<assets.Script>` also resolves and renders the entry's CSS
imports as `<link rel="stylesheet">` and (unless `preload={false}`) its JS
imports as `<link rel="modulepreload">`, all wired up by
`resolveEntry`/`asset` from the same manifest chunk. `ScriptProps`/
`LinkProps`/`ImgProps` all extend the underlying intrinsic element's
attributes (minus the ones the component itself manages: `type`/`src` for
`Script`, `rel`/`href` for `Link`, `src` for `Img`), so any other standard
HTML attribute (`alt`, `data-*`, ...) passes straight through.

### Resolving a manifest entry to a raw URL

```ts
const logoUrl = assets.asset("src/logo.png");
// dev:  "/src/logo.png"
// prod: "/assets/logo-<hash>.png"
```

`asset()` is the primitive `Script`/`Link`/`Img` are built on, useful when you
need a fingerprinted URL outside of JSX (e.g. in a JSON API response or an
inline `<style>` block referencing a background image). Like the JSX
components, it throws `ViteEntryNotFoundError` in production for an unknown
name.

### Handling an unknown entry name

```ts
import { ViteEntryNotFoundError } from "@tknf/oven/vite";

try {
  assets.asset("src/does-not-exist.ts");
} catch (err) {
  if (err instanceof ViteEntryNotFoundError) {
    // the entry name doesn't match anything in build.rollupOptions.input
  }
}
```

This only happens in production (development treats every name as a literal
source path and never consults the manifest), and it's meant to be a build
failure you catch during testing/staging, not one that needs runtime
recovery in a real app — the fix is to correct the entry name or add it to
`build.rollupOptions.input`.

## Gotchas / Security notes

- **Reading `manifest.json` off disk/bundle is your app's responsibility, not
  oven's.** `ViteAssets` never fetches or locates the manifest file itself —
  you read it (via `node:fs`, an imported JSON asset, or a Worker-bundled
  string) and pass the parsed result in as `manifest`. See
  [Deployment § Serving production assets](./deployment.md#serving-production-assets-tknfovenvite)
  for how this differs between a Cloudflare Worker and a Node process.
- **An unknown entry name is fail-closed, not fail-soft.** Unlike
  `decodeCursor` in `@tknf/oven/pagination`, `ViteEntryNotFoundError` is
  thrown rather than swallowed — a typo'd entry name should surface loudly in
  development/CI rather than silently render a broken `<script src="">`.
- **Don't mix up `mode` with the actual environment.** `ViteAssets` never
  reads `import.meta.env` or `process.env.NODE_ENV` — passing the wrong
  `mode` (e.g. `"development"` in a deployed Worker) will serve raw source
  paths that don't exist in your production bundle, and there is no runtime
  check that catches this mismatch for you.
- **The constructor validates eagerly, not lazily.** Constructing
  `new ViteAssets({ mode: "production" })` without a `manifest` throws
  immediately rather than on first use of `Script`/`Link`/`Img`/`asset` — a
  deliberate fail-fast choice so a missing manifest surfaces at startup, not
  on the first request that happens to hit a rendering path.
- **`parseViteManifest` expects the exact Vite `manifest.json` shape** (an
  object keyed by entry name, each value at least `{ file: string }`). Only
  `file`/`css`/`imports`/`isEntry` are read — passing a hand-written or
  differently-shaped JSON string will throw `ViteManifestParseError` rather
  than silently producing a manifest with missing fields.

## See also

- [Deployment](./deployment.md) — where the production manifest read fits
  into a Cloudflare Worker vs. Node deployment.
- [View](./view.md) — how `assets.Script`/`assets.Link`/`assets.ViteClient`
  fit into a `Layout`'s JSX output.
- [Getting started](./getting-started.md) — the first layout that wires in
  `ViteAssets`.
