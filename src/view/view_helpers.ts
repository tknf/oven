/**
 * Thin view helpers layered on top of `useRequestContext` (`hono/jsx-renderer`).
 *
 * Following the design principle "the clarity of pure JSX is an asset, so
 * don't touch it further", what's provided here is only a means to access
 * cross-cutting concerns (CSRF token, flash message, current authenticated
 * user, i18n) from within a JSX component without threading `c` (`Context`)
 * through every call — it holds no logic of its own. The actual behavior is
 * just delegation: partially applying existing accessors (`Csrf`'s
 * `csrfToken`, `SessionAccessor`'s `use`, the auth accessor returned by a
 * Guard, `Translator`'s `t`) to the `Context` obtained via
 * `useRequestContext()`.
 *
 * **Class-based approach (`ViewHelpers`)**: the framework doesn't know things
 * like "which key the app stores the session under" or "which Guard it uses".
 * So the app passes its own bundle of accessors (`ViewHelperOptions`), and
 * this generates a set of helpers that can be called with no arguments
 * (except `t`, which takes a key) from within a view.
 *
 * **The 4 helpers always exist.** Calling one whose corresponding dependency
 * wasn't provided throws with a clear message, such as "csrfToken is not
 * wired up (pass csrfToken to the ViewHelpers constructor)".
 */
import type { Context, Env } from "hono";
import { useRequestContext } from "hono/jsx-renderer";
import type { Catalog, Translate, TranslateParams } from "../i18n/i18n.js";
import type { Session } from "../session/session.js";

/**
 * Bundle of accessors passed to the `ViewHelpers` constructor. All optional.
 * The helper corresponding to a dependency that wasn't provided throws with a
 * clear message when called (see the `ViewHelpers` JSDoc below).
 *
 * - `csrfToken`: pass `Csrf`'s `csrfToken` as-is
 * - `session`: pass `SessionAccessor`'s `use` as-is (backs `flash()`; since
 *   `flash()` is consume-once and can dirty the session on every call, its
 *   incompatibility with streaming responses (`stream: true`) is documented
 *   in the module JSDoc of `session_accessor.ts`)
 * - `currentUser`: accessor that returns the current authenticated user.
 *   **The contract is to pass a "safe version" that doesn't throw** (see the
 *   `ViewHelpers` JSDoc below)
 * - `t`: pass `Translator`'s `t` as-is
 */
export type ViewHelperOptions<E extends Env = Env, C extends Catalog = Catalog, U = unknown> = {
	csrfToken?: (c: Context<E>) => string;
	session?: (c: Context<E>) => Session;
	currentUser?: (c: Context<E>) => U | undefined;
	t?: Translate<C>;
};

/**
 * Class providing thin view helpers layered on top of `useRequestContext()`.
 *
 * Each helper is a thin function that, when called, retrieves the `Context`
 * via `useRequestContext()` and simply delegates to the corresponding
 * accessor. So the following two kinds of failure are not built anew here;
 * instead the behavior the delegate already has surfaces as-is (failure
 * reasons are concentrated in one place — the delegate — rather than relying
 * on implicit knowledge):
 *
 * - **Called outside a renderer**: `useRequestContext()` itself throws
 *   `"RequestContext is not provided."` (the default behavior of
 *   `hono/jsx-renderer`)
 * - **An accessor throws due to being unregistered/unauthenticated/etc.**:
 *   that accessor's `throw` (e.g. `SessionAccessor`'s `use` throwing
 *   `"session" is not registered`) propagates as-is
 *
 * Since helpers may be destructured within a view (e.g.
 * `const { t, flash } = helpers`), **every helper is an arrow-function class
 * field** (to preserve `this` binding).
 *
 * **The `currentUser` contract**: the `currentUser` received here is assumed
 * to be a "safe version that returns `undefined` when unauthenticated" (do
 * not pass a Guard's `use`-style accessor that throws, as-is). Two reasons:
 * 1. It must be callable unconditionally from the view layer (including
 *    layouts that also serve unauthenticated pages, etc.), and if this thin
 *    helper layer swallowed arbitrary exceptions on every call, misconfiguration
 *    exceptions like "session not registered" would also get uniformly
 *    turned into `undefined`, violating the design principle of not relying
 *    on implicit knowledge (failures should be easy to spot)
 * 2. Authentication policy (what counts as "failing safely") is the app's
 *    responsibility and should not be hardcoded on the framework side
 *
 * The app is therefore expected to prepare and pass a "safe version" accessor
 * separate from the exception-throwing Guard's `use`, e.g.
 * `(c) => { try { return guard.use(c); } catch { return undefined; } }`.
 */
export class ViewHelpers<E extends Env, C extends Catalog = Catalog, U = unknown> {
	private readonly options: ViewHelperOptions<E, C, U>;

	constructor(options: ViewHelperOptions<E, C, U>) {
		this.options = options;
	}

	readonly csrfToken = (): string => {
		const { csrfToken } = this.options;
		if (!csrfToken) {
			throw new Error("csrfToken is not wired up (pass csrfToken to the ViewHelpers constructor)");
		}
		return csrfToken(useRequestContext<E>());
	};

	readonly flash = (key: string): unknown => {
		const { session } = this.options;
		if (!session) {
			throw new Error("flash is not wired up (pass session to the ViewHelpers constructor)");
		}
		return session(useRequestContext<E>()).get(key);
	};

	readonly currentUser = (): U | undefined => {
		const { currentUser } = this.options;
		if (!currentUser) {
			throw new Error(
				"currentUser is not wired up (pass currentUser to the ViewHelpers constructor)",
			);
		}
		return currentUser(useRequestContext<E>());
	};

	readonly t = (key: keyof C & string, params?: TranslateParams): string => {
		const { t } = this.options;
		if (!t) {
			throw new Error("t is not wired up (pass t to the ViewHelpers constructor)");
		}
		return t(useRequestContext<E>(), key, params);
	};
}
