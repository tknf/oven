/**
 * Maintenance mode middleware that takes an injected `KeyValueStore`. Follows the same design
 * as `FeatureFlags` (`kv/feature_flags.ts`), storing the string `"1"` (in maintenance) /
 * `"0"` (normal operation). Similarly, `disable` writes `"0"` rather than deleting the key —
 * to distinguish "explicitly disabled" from "never set".
 *
 * Because `KeyValueStore` is built on an eventual-consistency contract (see
 * `key_value_store.ts`), there can be a delay before `enable`/`disable` propagates to other
 * requests' `enabled`/`use` calls. Not suitable for use cases requiring strict, immediately
 * synchronized toggling.
 *
 * `enabled` fails open (any value other than `"1"` — unset, `"0"`, or an unexpected string —
 * is treated as "not in maintenance, i.e. normal operation"). Since maintenance mode reduces
 * availability, the unset state defaults to the safe side (serving traffic). If `store.get`
 * throws due to a KV store failure, that exception propagates to the caller as-is (a failure
 * must never be mistaken for a normal "maintenance disabled" state).
 */
import type { Context, Env, MiddlewareHandler, Next } from "hono";
import type { KeyValueStore } from "../kv/key_value_store.js";

export type MaintenanceModeOptions = {
	/** Storage key passed to the store. Defaults to `"maintenance"`. */
	key?: string;
	/**
	 * Prefix-match list of paths allowed through even during maintenance. Defaults to
	 * `["/up"]` (health checks are allowed by default). Providing a value replaces the default.
	 */
	allowPaths?: string[];
	/** Seconds for the maintenance response's `Retry-After` header. Defaults to `600`. Ignored when `render` is specified. */
	retryAfterSeconds?: number;
	/**
	 * Overrides the maintenance response. When provided, this return value is used as-is
	 * (attaching a `Retry-After` header also becomes the caller's responsibility).
	 */
	render?: (c: Context) => Response | Promise<Response>;
};

/** Bundles the toggling, checking, and middleware for maintenance mode backed by a `KeyValueStore`. */
export class MaintenanceMode<E extends Env = Env> {
	private readonly store: KeyValueStore;
	private readonly key: string;
	private readonly allowPaths: string[];
	private readonly retryAfterSeconds: number;
	private readonly render?: (c: Context) => Response | Promise<Response>;

	constructor(store: KeyValueStore, options?: MaintenanceModeOptions) {
		this.store = store;
		this.key = options?.key ?? "maintenance";
		this.allowPaths = options?.allowPaths ?? ["/up"];
		this.retryAfterSeconds = options?.retryAfterSeconds ?? 600;
		this.render = options?.render;
	}

	/** Enables maintenance mode. */
	enable = async (): Promise<void> => {
		await this.store.set(this.key, "1");
	};

	/**
	 * Disables maintenance mode. Writes `"0"` rather than deleting the key
	 * (to distinguish it from "unset").
	 */
	disable = async (): Promise<void> => {
		await this.store.set(this.key, "0");
	};

	/**
	 * Returns whether maintenance mode is enabled. `true` only when the stored value is `"1"`.
	 * Unset, `"0"`, and any other value are all `false` (fail-open).
	 */
	enabled = async (): Promise<boolean> => {
		const value = await this.store.get(this.key);
		return value === "1";
	};

	/** An arrow-function class field so it can be passed by reference, e.g. `app.use(maintenanceMode.use)`. */
	readonly use: MiddlewareHandler<E> = async (c: Context<E>, next: Next) => {
		if (!(await this.enabled())) {
			await next();
			return;
		}

		const path = c.req.path;
		if (this.allowPaths.some((allowPath) => path.startsWith(allowPath))) {
			await next();
			return;
		}

		if (this.render) {
			return await this.render(c);
		}

		return c.text("Service Unavailable", 503, {
			"Retry-After": String(this.retryAfterSeconds),
		});
	};
}
