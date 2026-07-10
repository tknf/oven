/**
 * Authentication guard. Folds the skeleton shared by authentication checks
 * that differ only in their failure response (302 redirect, 401 JSON, 303
 * redirect, etc.) — "cookie -> identifier from session -> resolve subject ->
 * `c.set`" — into a single class where only the failure-response behavior is
 * swappable.
 *
 * `session` is accepted the same way as `Csrf` (`(c) => Session`; intended to
 * be passed `SessionAccessor`'s `use` as-is). If the session is not wired up
 * (i.e. `register` was never applied), `useSession(c)` itself throws with the
 * key name embedded (the same decision as `security/csrf.ts`: Guard does not
 * add extra handling for this, so a wiring omission — a configuration mistake
 * — is not silently swallowed inside Guard).
 *
 * `provider` is a function that resolves the subject from an identifier (a
 * string obtained via `session.get(identityKey)`). It can look the identifier
 * up in a DB (e.g. `(id) => accounts.retrieve(id)`), or it can be an identity
 * function that returns the identifier itself as the subject (`(id) => id`,
 * for cases where the session value alone is used for the decision, without a
 * DB lookup) — both are expressible with the same class.
 *
 * **Design decision 1: path exclusion is exact-match `except`, not patterns**.
 * The primary way to exclude a path is still Hono's own routing (per-path
 * middleware application via `app.on`, sub-app mount ranges, omitting
 * `require` on individual routes) — that stays the first choice. But relying
 * on routing alone means the guarantee lives entirely in registration order
 * (e.g. mounting a public login handler before `app.use("/admin/*",
 * guard.require)`), and a future reordering mistake becomes a silent
 * authentication bypass with no error to catch it. `except` (a list of exact
 * request paths, mirroring `Csrf`'s `exceptions`) lets that guarantee be
 * expressed directly in the Guard's own configuration instead of depending on
 * registration order. It intentionally stays exact-match only — no glob or
 * prefix matching — so Guard never grows a second responsibility of pattern-
 * based routing on top of its authentication decision.
 *
 * **Design decision 2: `Cache-Control: no-store` after passing authentication
 * is ON by default (can be disabled via `cacheControl`)**. This prevents an
 * authenticated screen from being shown again via the browser's back button
 * after logout, through the bfcache or an HTTP cache. Since "don't leave
 * authenticated responses in an intermediate cache" is equally harmless and
 * useful for JSON APIs, it was made an ON-by-default for Guard in general
 * (giving page-oriented and API-oriented uses different defaults would only
 * add the burden of remembering which is which). Opt out explicitly with
 * `cacheControl: false` where it's not needed.
 *
 * **Design decision 3: remember-me integration gives Guard exactly one
 * responsibility — "re-establishing the session"**. `remember` (expected to be
 * `RememberToken#consume`) is an additional resolution path tried only when
 * the session has no identifier. On success, it sets
 * `session.set(identityKey, identity)` to reproduce the same state as normal
 * session authentication, schedules an ID reissue via `session.regenerate()`
 * for session-fixation protection, and then merges back into the existing
 * `provider` resolution path. Generating, verifying, and rotating the token
 * itself remains `RememberToken`'s responsibility and is not brought into
 * Guard (Guard focuses solely on "deciding authentication state" and does not
 * depend on any specific remember-token implementation — hence it is accepted
 * as a structural type).
 */
import type { Context, Env, MiddlewareHandler, Next } from "hono";
import { ContextAccessor } from "../routing/context_accessor.js";
import type { Session } from "../session/session.js";

export type GuardOptions<E extends Env, K extends keyof E["Variables"] & string> = {
	/** Session accessor. Intended to be passed `SessionAccessor`'s `use` as-is. */
	session: (c: Context<E>) => Session;
	/**
	 * The key used to read the identifier from the session. If the value is not
	 * a `string`, the request is treated as unauthenticated.
	 *
	 * **Contract (important)**: this key's value must always be set via
	 * `session.set`. Setting it via `session.flash` will cause it to be consumed
	 * on the first protected request due to `Session#get`'s consume-once
	 * behavior (see `session.ts`), leaving subsequent requests unauthenticated
	 * (this shows up as a bug where the user is logged out immediately after
	 * logging in).
	 */
	identityKey: string;
	/**
	 * Resolves the subject from an identifier. Returning `null`/`undefined`
	 * falls through to `onFailure` as an authentication failure. Pass an
	 * identity function if the identifier itself should be treated as the
	 * subject.
	 */
	provider: (
		identity: string,
		c: Context<E>,
	) => E["Variables"][K] | null | undefined | Promise<E["Variables"][K] | null | undefined>;
	/** Builds the response for an unauthenticated request (302/303 redirect, 401 JSON, etc. — the differences among the current 3 kinds all fold in here). */
	onFailure: (c: Context<E>) => Response | Promise<Response>;
	/** Whether to attach `Cache-Control: no-store` after passing authentication. Default `true`. */
	cacheControl?: boolean;
	/**
	 * The remember-me token consumption entry point. `consume` is tried only
	 * when the session has no identifier; if an identity is obtained,
	 * `session.set(identityKey, identity)` and `session.regenerate()` (session
	 * fixation protection) are performed before proceeding to the provider
	 * resolution. Intended to be passed `RememberToken#consume` as-is (accepted
	 * as a structural type, so there is no direct dependency).
	 */
	remember?: { consume: (c: Context<E>) => Promise<string | null> };
	/**
	 * Request paths (`c.req.path`) that are exempted from this Guard entirely.
	 * A path is exempted only on an **exact match** — no glob/prefix matching.
	 * Keep the list minimal.
	 *
	 * On an exempted request, `handle` does nothing but `await next()`: it does
	 * not read the session, does not call `provider`, does not `c.set` the
	 * subject, and does not attach `Cache-Control`. Because the subject is
	 * never set, calling this Guard's `use(c)` inside a handler mounted on an
	 * excepted path will throw (per `ContextAccessor#use`'s contract) — only
	 * use `except` for genuinely public routes that don't call `use`.
	 *
	 * Intended use: opening a small number of public paths (e.g. a login page)
	 * inside an otherwise-protected range without relying solely on
	 * registration order (mounting the public handler before `require`), where
	 * a future reordering mistake would silently bypass authentication.
	 */
	except?: string[];
};

export class Guard<E extends Env, K extends keyof E["Variables"] & string> extends ContextAccessor<
	E,
	K
> {
	private readonly options: GuardOptions<E, K>;

	constructor(key: K, options: GuardOptions<E, K>) {
		super(key);
		this.options = options;
	}

	/**
	 * The same instance as the base class's `register` (the base class field is
	 * already initialized during `super()`, so it can be safely referenced at
	 * this field's initialization time).
	 */
	readonly require: MiddlewareHandler<E> = this.register;

	protected async handle(c: Context<E>, next: Next): Promise<Response | void> {
		const {
			session: useSession,
			identityKey,
			provider,
			onFailure,
			cacheControl = true,
			remember,
			except = [],
		} = this.options;

		if (except.includes(c.req.path)) {
			await next();
			return;
		}

		const session = useSession(c);
		let identity = session.get(identityKey);

		if (typeof identity !== "string" && remember) {
			const rememberedIdentity = await remember.consume(c);
			if (typeof rememberedIdentity === "string") {
				session.set(identityKey, rememberedIdentity);
				session.regenerate();
				identity = rememberedIdentity;
			}
		}

		if (typeof identity !== "string") {
			return onFailure(c);
		}

		const subject = await provider(identity, c);
		if (subject === null || subject === undefined) {
			return onFailure(c);
		}

		c.set(this.key, subject);
		await next();

		if (cacheControl) {
			c.header("Cache-Control", "no-store");
		}
	}

	protected registerHint(): string {
		return "Apply Guard's `require` middleware";
	}
}
