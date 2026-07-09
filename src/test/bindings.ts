/**
 * Generic building block that creates a dummy stub satisfying an external
 * binding type (KV, R2, Fetcher, etc.) with no real behavior. Bundled as part
 * of `@tknf/oven/test`.
 *
 * For tests that need to pass a value which only has to satisfy a type but is
 * never actually used at runtime, this generates a Proxy that always returns
 * a no-op function on every property access. A factory that assembles an
 * app's full `AppEnv["Bindings"]` is out of scope here; each app is expected
 * to use this function as a building block and compose its own binding-set
 * factory on top of it.
 */
export const stubBinding = <T extends object>(): T =>
	new Proxy(
		{},
		{
			get: () => () => undefined,
		},
	) as T;
