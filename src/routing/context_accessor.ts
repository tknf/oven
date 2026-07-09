/**
 * Abstract base class for typed dependency injection through the Hono context.
 *
 * A provider-container approach was rejected as unnecessary cognitive overhead. Instead,
 * this module offers an abstract base class, `ContextAccessor`, that implements the
 * register/use pattern — an accessor that wraps `c.set`/`c.get` and throws a clear
 * message when the value has not been registered — and lets it be reproduced through
 * inheritance.
 *
 * Concrete subclasses only need to implement `handle` (the per-request work) and
 * `registerHint` (the hint text shown when the value is missing). For the simplest case
 * of "just `c.set` a value as-is", use `ValueAccessor` below.
 *
 * The canonical pattern is for an application's wiring module (e.g. `src/lib/db.ts`) to
 * construct a `ScopedValueAccessor` instance, keep the instance itself private, and only
 * export the `register`/`use` function pair (callers specify the type parameter `E`
 * explicitly):
 *
 * ```ts
 * type AppBindings = { DATABASE_URL: string };
 * type AppEnv = { Bindings: AppBindings; Variables: { db?: Database } };
 *
 * // Wiring module on the app side (e.g. src/lib/db.ts). The instance stays private;
 * // only the function pair is exported.
 * const accessor = new ScopedValueAccessor<AppEnv, "db">("db", { create: (c) => drizzle(c.env.DATABASE_URL) });
 * export const registerDatabase = accessor.register;
 * export const useDatabase = accessor.use;
 *
 * // main.ts: app.use(registerDatabase);
 * // Inside a handler: const db = useDatabase(c);
 * ```
 *
 * `register`/`use` are class-field arrow functions (rather than prototype methods)
 * precisely to support this detachment (passing them by reference apart from the
 * instance, as named exports). Extracting a prototype method like `accessor.register`
 * would lose its `this` binding and break.
 */
import type { Context, Env, MiddlewareHandler, Next } from "hono";
import { createMiddleware } from "hono/factory";

export abstract class ContextAccessor<E extends Env, K extends keyof E["Variables"] & string> {
	constructor(protected readonly key: K) {}

	/**
	 * Since this is passed by reference detached from `this` (as in `app.use(x.register)`),
	 * it is a class-field arrow function so the `this` binding is preserved.
	 */
	readonly register: MiddlewareHandler<E> = createMiddleware<E>((c, next) => this.handle(c, next));

	/**
	 * Retrieves the registered value. Throws an error naming the key if it has not been
	 * registered (i.e. called on a route where `register` was not applied). `use` is
	 * also a class-field arrow function because it is passed by reference from handler
	 * code (e.g. `options.session: sessionAccessor.use`).
	 *
	 * It is generic over `E2 extends E` because Hono's `Context` uses `Variables` in
	 * both the set and get directions, so a `Context` for an extended env (e.g. `AdminEnv`
	 * extending `AppEnv`) cannot simply be implicitly converted to `Context<AppEnv>`.
	 * Accepting `E2 extends E` lets handlers with an extended env call `use(c)` directly
	 * (the same solution used by `useDatabase` in `src/lib/db.ts`).
	 */
	readonly use = <E2 extends E>(c: Context<E2>): NonNullable<E["Variables"][K]> => {
		const value = c.get(this.key);
		if (value === undefined || value === null) {
			throw new Error(`"${this.key}" has not been registered (${this.registerHint()})`);
		}
		return value;
	};

	/**
	 * The per-request work. Since it is invoked from `register` (an arrow-function field
	 * built while the base constructor runs), subclass overrides must be written as
	 * **prototype methods** (class fields are initialized after `super()` completes, so
	 * they would not be ready in time — the same reasoning as constraint 2 in
	 * `route_handler.ts`).
	 */
	protected abstract handle(c: Context<E>, next: Next): Promise<Response | void>;

	/** Hint text describing "what to apply" for the not-registered error message in `use`. */
	protected abstract registerHint(): string;
}

/**
 * The simplest `ContextAccessor`: it just `c.set(key, ...)`s the value from `create(c)`
 * and calls `next`.
 */
export class ValueAccessor<
	E extends Env,
	K extends keyof E["Variables"] & string,
> extends ContextAccessor<E, K> {
	constructor(
		key: K,
		private readonly create: (c: Context<E>) => E["Variables"][K] | Promise<E["Variables"][K]>,
	) {
		super(key);
	}

	protected async handle(c: Context<E>, next: Next): Promise<void> {
		const value = await this.create(c);
		c.set(this.key, value);
		await next();
	}

	protected registerHint(): string {
		return "apply the ValueAccessor's register middleware";
	}
}

export type ScopedValueAccessorOptions<E extends Env, K extends keyof E["Variables"] & string> = {
	/** Creates the value. Expected to wrap `create(c.env)` as `(c) => createValue(c.env)`. */
	create: (c: Context<E>) => E["Variables"][K] | Promise<E["Variables"][K]>;
	/**
	 * `"request"` (default): calls `create` on every request — for values that must be
	 * built fresh per request, such as a client derived from a per-request binding.
	 * `"app"`: memoizes the first `create` result inside the instance and reuses it for
	 * all requests (for Node-style connection pools; memoization caches the `Promise`
	 * itself, so even concurrent requests only trigger a single creation).
	 */
	scope?: "request" | "app";
};

/**
 * A general-purpose wiring class that adds `scope`-based memoization to `ValueAccessor`.
 * `DatabaseAccessor` is the only service with a dedicated accessor; wiring for every
 * other service (`Logger`, `Mailer`, `Storage`, `KeyValueStore`, `JobQueue`,
 * `Broadcaster`, `Cache`, `RateLimiter`, `Encrypter`, etc.) uses this class directly and
 * is exported as a named `registerLogger`/`useLogger`-style function pair (see the usage
 * example in this module's header JSDoc).
 *
 * - `"request"` (default): calls `create` on every request. Intended for runtimes such
 *   as Cloudflare Workers, where a client is built per request from a binding on `c.env`
 *   (e.g. D1, Hyperdrive) because binding reuse across requests is not guaranteed.
 * - `"app"`: memoizes the first `create` result inside this instance and reuses it for
 *   every subsequent request. Intended for runtimes such as Node where you want to
 *   create exactly one client with a connection pool for the whole process. Memoization
 *   caches the `Promise` returned by `create` rather than the resolved value itself (the
 *   same technique as `Encrypter`'s `keyCache`), so `create` runs at most once even when
 *   multiple first requests arrive concurrently. If `create` fails (rejects), the
 *   rejection is not cached, and `create` is retried on the next request (making it
 *   retryable — permanently caching a failed promise would otherwise make every request
 *   fail with the same error until the process/isolate restarts).
 */
export class ScopedValueAccessor<
	E extends Env,
	K extends keyof E["Variables"] & string,
> extends ContextAccessor<E, K> {
	private readonly create: (c: Context<E>) => E["Variables"][K] | Promise<E["Variables"][K]>;
	private readonly scope: "request" | "app";

	/** Memoization slot for `scope: "app"`. Caches the `Promise` itself, not the value. */
	private appInstance: Promise<E["Variables"][K]> | undefined;

	constructor(key: K, options: ScopedValueAccessorOptions<E, K>) {
		super(key);
		this.create = options.create;
		this.scope = options.scope ?? "request";
	}

	protected async handle(c: Context<E>, next: Next): Promise<void> {
		const value = await this.resolve(c);
		c.set(this.key, value);
		await next();
	}

	private resolve(c: Context<E>): Promise<E["Variables"][K]> {
		if (this.scope === "request") {
			return Promise.resolve(this.create(c));
		}

		if (!this.appInstance) {
			const promise = Promise.resolve(this.create(c));
			this.appInstance = promise;
			/**
			 * Do not cache initialization failures. On rejection, clear the cache only if
			 * the same promise is still cached (leave it alone if a concurrent request has
			 * already replaced it with a new promise), so the next request can retry `create`.
			 */
			promise.catch(() => {
				if (this.appInstance === promise) this.appInstance = undefined;
			});
		}
		return this.appInstance;
	}

	protected registerHint(): string {
		return "apply the ScopedValueAccessor's register middleware";
	}
}
