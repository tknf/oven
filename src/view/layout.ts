/**
 * Type definitions around Layout (a component for `hono/jsx-renderer`).
 *
 * Head injection uses the "props approach" as the official API. The second
 * argument of `c.render(<Page/>, { title, head })` is typed through Hono's
 * standard `ContextRenderer` interface (empty by default). Since directly
 * augmenting this interface from the framework side would affect the app's
 * global types, **declaring the augmentation is the app's responsibility**.
 * The app declares it like this (typically alongside `src/env.ts`):
 *
 * ```ts
 * import type { LayoutProps } from "@tknf/oven";
 *
 * declare module "hono" {
 *   interface ContextRenderer {
 *     (content: string | Promise<string>, props: LayoutProps): Response | Promise<Response>;
 *   }
 * }
 * ```
 *
 * Layout inheritance is done via **function composition** (e.g. `AdminLayout`
 * wraps `BaseLayout` by merging props; `AdminLayout` itself just assembles the
 * props to pass to `BaseLayout` and passes `children` through untouched).
 * The two-phase (named-slot) approach was rejected: because hono/jsx
 * evaluates in document order, a naive implementation (where the layout's
 * head reads a slot directly) would render head before body is evaluated,
 * which doesn't work. A two-phase approach — an async layout plus
 * `await jsx(Fragment, {}, children).toString()` to force evaluation first —
 * would work, but is incompatible with streaming SSR. Since real-world head
 * injection needs are page-level information that props already cover, the
 * two-phase approach is only noted here as a fallback in case it becomes
 * unavoidable.
 */
import type { Child, PropsWithChildren } from "hono/jsx";
import type { jsxRenderer } from "hono/jsx-renderer";

/**
 * Type of the first argument to `jsxRenderer` (hono/jsx-renderer) — the layout
 * component itself. Since `jsxRenderer` makes `component` optional
 * (`component?:`), the actual type is derived from
 * `NonNullable<Parameters<typeof jsxRenderer>[0]>` (Hono itself does not
 * export a named type for this). Used as the return type of
 * `RouteHandler#layout()`.
 */
export type LayoutComponent = NonNullable<Parameters<typeof jsxRenderer>[0]>;

/**
 * Type of the common layout props passed as `props` in `c.render(<Page/>, props)`.
 * `title` is required (the page title). `head` is an optional slot for
 * page-specific additional head elements (`<meta>`, `<link>`, etc.); the
 * layout is expected to expand it as `{head}` inside `<head>`.
 */
export type LayoutProps = PropsWithChildren<{
	title: string;
	head?: Child;
}>;
