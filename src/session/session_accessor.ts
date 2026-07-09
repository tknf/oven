/**
 * An auto-committing session accessor, so handlers do not have to hand-write session
 * save/initialization logic:
 *
 * 1. At the start of a request, calls `storage.get()` with the Cookie header and
 *    `c.set`s the result under `key`.
 * 2. After `next()` runs, if that session is `isDirty` (a `set`/`unset`/`flash` call
 *    occurred, or a flash value was consumed), calls `storage.commit()` and appends
 *    the returned `Set-Cookie` value to the response. Does nothing if not dirty
 *    (avoids needless writes).
 *
 * The `key` handling, typing, and "throw if not registered via `use`" conventions
 * follow the `ContextAccessor` base class in `context_accessor.ts` (`SessionAccessor`
 * extends it). Why not use `ValueAccessor` directly: that class is a one-way hook that
 * simply "registers and moves on", whereas the two-way wiring of checking dirtiness
 * after `next()` and then committing is specific to this class's concern.
 *
 * `storage` can be either a fixed instance or a `(c) => SessionStorage` factory, for
 * storages (such as one needing Cloudflare bindings) that require a per-request value
 * derived from `c`.
 *
 * **Note (behavior on error)**: if `next()` throws, the automatic `Set-Cookie` is not
 * applied (the exception passes through this accessor untouched, and the response
 * produced by `error_handler.ts`'s `onError` does not carry the `Set-Cookie` from
 * here). If you need session changes made before the error (e.g. a flash pushed prior
 * to throwing) to be saved reliably even on an error response, the caller must call
 * `storage.commit()` explicitly before throwing.
 *
 * **Note (incompatible with streaming)**: this accessor's `register` cannot be
 * combined with `jsxRenderer`'s (`hono/jsx-renderer`) `stream: true`. Because a
 * streaming response must finalize and send its HTTP headers before the body is sent,
 * session changes made during rendering (including dirtying via consuming `flash()`
 * inside a view; see `view_helpers.ts`) cannot be reflected in `Set-Cookie`. This is
 * not something implementation effort can work around — it is a constraint of the
 * HTTP protocol itself. If you need to change the session while using a streaming
 * response, call `storage.commit()` explicitly before calling `next()` (i.e. before
 * streaming begins in the handler body).
 */
import type { Context, Env, Next } from "hono";
import { ContextAccessor } from "../routing/context_accessor.js";
import { SessionStorage } from "./session_storage.js";

export class SessionAccessor<
	E extends Env,
	K extends keyof E["Variables"] & string,
> extends ContextAccessor<E, K> {
	constructor(
		key: K,
		private readonly storage: SessionStorage | ((c: Context<E>) => SessionStorage),
	) {
		super(key);
	}

	private resolveStorage(c: Context<E>): SessionStorage {
		return this.storage instanceof SessionStorage ? this.storage : this.storage(c);
	}

	protected async handle(c: Context<E>, next: Next): Promise<void> {
		const sessionStorage = this.resolveStorage(c);
		const session = await sessionStorage.get(c.req.header("Cookie") ?? null);
		/**
		 * `E["Variables"][K]` is an unresolved type variable within this class, so
		 * TypeScript cannot prove at the type level that "the caller uses `K` for this
		 * purpose (storing a session)" (unlike `ValueAccessor.create` in
		 * `context_accessor.ts`, where the return type is directly constrained by the
		 * caller's own implementation). The contract itself is guaranteed by the type
		 * argument declaration (the caller writes `Variables: { [key: K]: Session }`),
		 * so the cast here is an accepted, safe trade-off.
		 */
		c.set(this.key, session as E["Variables"][K]);

		await next();

		if (session.isDirty) {
			const cookie = await sessionStorage.commit(session);
			c.header("Set-Cookie", cookie, { append: true });
		}
	}

	protected registerHint(): string {
		return "Apply the SessionAccessor register middleware";
	}
}
