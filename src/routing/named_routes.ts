/**
 * Reverse URL generation from named routes.
 *
 * Treats the "route name → path template" table passed to the constructor as the single
 * source of truth, and builds relative paths (`pathFor`) and absolute URLs (`urlFor` —
 * used for things like generating links in email bodies) in a type-safe way. There is no
 * automatic route discovery, and no automatic consistency check against what is
 * registered in `RouteHandler` (in keeping with the design principle of avoiding magic).
 * Restoring `hc` (Hono's RPC client) is out of scope.
 *
 * Path templates follow Hono's path syntax (`:id`, `:id?`, `:id{[0-9]+}`). Whether a
 * parameter is required or optional, and its type, are derived via template literal
 * types. `node_modules/hono` has a similar internal `ParamKeys` type but does not export
 * it from its public entry point, so this is a from-scratch implementation of the same
 * idea.
 *
 * ```ts
 * const routes = new NamedRoutes(
 *   {
 *     "books.index": "/books",
 *     "books.show": "/books/:id",
 *     "books.page": "/books/:id/pages/:page?",
 *   },
 *   { baseUrl: "https://example.com" },
 * );
 * routes.pathFor("books.index"); // "/books"
 * routes.pathFor("books.show", { id: "42" }); // "/books/42"
 * routes.urlFor("books.show", { id: "42" }); // "https://example.com/books/42"
 * ```
 */

/**
 * Extracts the parameter name from a single path-template segment (`:id`, `:id?`,
 * `:id{[0-9]+}`, `:id{[0-9]+}?`). Strips the regex qualifier `{...}` and, when the
 * parameter is optional, keeps a trailing `?` on the name (used by `ParamField` to
 * decide required vs. optional).
 */
type ParamSegmentName<Segment extends string> = Segment extends `:${infer NameWithPattern}`
	? NameWithPattern extends `${infer Name}{${infer Rest}`
		? Rest extends `${infer _Pattern}?`
			? `${Name}?`
			: Name
		: NameWithPattern
	: never;

/** Derives the set of parameter names (a union of `ParamSegmentName`) for a whole path template. */
type ParamNames<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
	? ParamSegmentName<Segment> | ParamNames<Rest>
	: ParamSegmentName<Path>;

/** The standard trick for converting a union to an intersection via a function argument's covariant position. */
type UnionToIntersection<TUnion> = (
	TUnion extends unknown ? (value: TUnion) => void : never
) extends (value: infer TIntersection) => void
	? TIntersection
	: never;

/** Converts a single parameter name (required vs. optional determined by a trailing `?`) into a one-field record. */
type ParamField<TKey extends string> = TKey extends `${infer Name}?`
	? { [P in Name]?: string | number }
	: { [P in TKey]: string | number };

/** Derives the parameter record type from a path template. An empty record if there are no parameters. */
export type PathParams<Path extends string> = [ParamNames<Path>] extends [never]
	? Record<string, never>
	: UnionToIntersection<
			ParamNames<Path> extends infer Key extends string ? ParamField<Key> : never
		>;

/** Additional options shared by `pathFor`/`urlFor`. */
export type PathForOptions = {
	/**
	 * Query string. No `?` is appended for an empty object. Array values `append` the
	 * same key multiple times.
	 */
	query?: Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>;
};

/**
 * The variadic argument list for `pathFor`/`urlFor`. Path templates without parameters
 * don't take a `params` argument at all (`[options?: PathForOptions]`); templates with
 * parameters require it (`[params: PathParams<Path>, options?: PathForOptions]`).
 */
export type PathForArgs<Path extends string> = [ParamNames<Path>] extends [never]
	? [options?: PathForOptions]
	: [params: PathParams<Path>, options?: PathForOptions];

export type NamedRoutesOptions = {
	/**
	 * Base for absolute URL generation (`urlFor`). Only absolute URLs starting with
	 * `http://`/`https://` are allowed. Trailing slashes are normalized away.
	 */
	baseUrl?: string;
};

/** The result of parsing a single path-template segment. */
type TemplateParam = {
	name: string;
	optional: boolean;
};

/** Type guard for a plain object (neither an array nor null). */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Type guard for a value type allowed as a parameter value (`string` or `number`). */
const isParamValue = (value: unknown): value is string | number =>
	typeof value === "string" || typeof value === "number";

/** Splits a single `:id` / `:id?` / `:id{[0-9]+}` / `:id{[0-9]+}?` segment into its name and optionality. */
const parseParamSegment = (segment: string): TemplateParam => {
	const withoutColon = segment.slice(1);
	const braceIndex = withoutColon.indexOf("{");
	if (braceIndex === -1) {
		return withoutColon.endsWith("?")
			? { name: withoutColon.slice(0, -1), optional: true }
			: { name: withoutColon, optional: false };
	}
	const name = withoutColon.slice(0, braceIndex);
	const rest = withoutColon.slice(braceIndex);
	return { name, optional: rest.endsWith("?") };
};

/** Extracts the parameter segments contained in a path template, in order. */
const extractParams = (template: string): TemplateParam[] =>
	template
		.split("/")
		.filter((segment) => segment.startsWith(":"))
		.map(parseParamSegment);

/** Whether a path template contains a wildcard (a whole `*` segment). */
const includesWildcard = (template: string): boolean => template.split("/").includes("*");

/**
 * A class that generates relative paths and absolute URLs in a type-safe way, reversed
 * from an explicitly provided "route name → path template" table. There is no automatic
 * route discovery.
 *
 * `TRoutes` is a `const` type parameter so that each property value of the object
 * literal passed to the constructor is inferred as its template literal type (rather
 * than being widened to `string`) — this avoids requiring callers to write `as const`.
 */
export class NamedRoutes<const TRoutes extends Record<string, string>> {
	private readonly baseUrl: string | undefined;

	constructor(
		private readonly routes: TRoutes,
		options: NamedRoutesOptions = {},
	) {
		for (const [name, template] of Object.entries(routes)) {
			if (includesWildcard(template)) {
				throw new Error(
					`NamedRoutes: route "${name}" has path template "${template}" containing a wildcard ("*"), which cannot be reverse-generated`,
				);
			}
		}

		if (options.baseUrl !== undefined) {
			if (!/^https?:\/\//.test(options.baseUrl)) {
				throw new Error(
					`NamedRoutes: baseUrl must be an absolute URL starting with "http://" or "https://" (received: "${options.baseUrl}")`,
				);
			}
			this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		}
	}

	/**
	 * Generates a relative path. Since this may be passed by reference detached from the
	 * instance (as in `const { pathFor } = routes`), it is a class-field arrow function
	 * that preserves the `this` binding.
	 */
	pathFor = <TName extends keyof TRoutes & string>(
		name: TName,
		...args: PathForArgs<TRoutes[TName]>
	): string => {
		const template = this.routes[name];
		const hasParams = extractParams(template).length > 0;
		const rawParams = hasParams ? args[0] : undefined;
		const rawOptions = hasParams ? args[1] : args[0];

		const params = isPlainObject(rawParams) ? rawParams : {};
		const options = isPlainObject(rawOptions) ? (rawOptions as PathForOptions) : undefined;

		const path = this.buildPath(name, template, params);
		return this.appendQuery(path, options?.query);
	};

	/**
	 * Generates an absolute URL prefixed with `baseUrl` (for use cases like generating
	 * links in email bodies, where a relative path won't do). Like `pathFor`, this is a
	 * class-field arrow function.
	 */
	urlFor = <TName extends keyof TRoutes & string>(
		name: TName,
		...args: PathForArgs<TRoutes[TName]>
	): string => {
		if (this.baseUrl === undefined) {
			throw new Error(`NamedRoutes: calling urlFor("${name}") requires baseUrl to be set`);
		}
		return `${this.baseUrl}${this.pathFor(name, ...args)}`;
	};

	/**
	 * Builds the relative path by substituting parameter values into the path template's
	 * segments. If an optional parameter is not supplied, its segment is dropped
	 * entirely; if the result is empty, returns `"/"`.
	 */
	private buildPath(name: string, template: string, params: Record<string, unknown>): string {
		const segments = template.split("/").flatMap((segment) => {
			if (!segment.startsWith(":")) return [segment];

			const param = parseParamSegment(segment);
			const rawValue = params[param.name];
			const hasValue = rawValue !== undefined && rawValue !== null && rawValue !== "";

			if (!hasValue) {
				if (param.optional) return [];
				throw new Error(
					`NamedRoutes: parameter "${param.name}" for route "${name}" was not provided`,
				);
			}
			if (!isParamValue(rawValue)) {
				throw new Error(
					`NamedRoutes: parameter "${param.name}" for route "${name}" must be a string or number`,
				);
			}
			return [encodeURIComponent(String(rawValue))];
		});

		const path = segments.join("/");
		return path === "" ? "/" : path;
	}

	/** Builds the query options with `URLSearchParams` and appends them to the path. */
	private appendQuery(path: string, query: PathForOptions["query"]): string {
		if (!query || Object.keys(query).length === 0) return path;

		const searchParams = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (Array.isArray(value)) {
				for (const item of value) searchParams.append(key, String(item));
			} else {
				searchParams.append(key, String(value));
			}
		}
		return `${path}?${searchParams.toString()}`;
	}
}
