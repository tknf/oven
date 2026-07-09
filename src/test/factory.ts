/**
 * Minimal test data factory. A generic helper that doesn't depend on model
 * classes or an ORM like Drizzle, separating
 * "building default values" from "persisting" them. Persistence is delegated
 * to a function injected by the caller (`persist`), so this can be combined
 * with any dialect or model layer. It avoids duplicated hardcoded test data,
 * expressing only the per-test differences via `overrides`.
 *
 * The only state is a sequence counter, and there's no need for inheritance,
 * so this is provided as a function rather than a class (consistent with
 * design principle 2, "keep pure functions as functions").
 */
export type Factory<TInput, TRow> = {
	/** Builds input by overlaying `overrides` on the default values (does not persist). */
	build: (overrides?: Partial<TInput>) => TInput;
	/** Passes the result of `build` to `persist` to persist it. */
	create: (overrides?: Partial<TInput>) => Promise<TRow>;
	/** Resets the sequence counter to 0 (for test independence). */
	reset: () => void;
};

/**
 * Defines a factory.
 *
 * @example
 * ```ts
 * const books = new BookModel(db);
 * const bookFactory = defineFactory(
 *   (input) => books.create(input),
 *   (seq) => ({ title: `Book ${seq}`, status: "draft" }),
 * );
 * const book = await bookFactory.create({ status: "published" });
 * ```
 */
export const defineFactory = <TInput, TRow>(
	persist: (input: TInput) => Promise<TRow>,
	defaults: (seq: number) => TInput,
): Factory<TInput, TRow> => {
	let seq = 0;

	const build = (overrides?: Partial<TInput>): TInput => {
		seq += 1;
		return { ...defaults(seq), ...overrides };
	};

	const create = async (overrides?: Partial<TInput>): Promise<TRow> => {
		return persist(build(overrides));
	};

	const reset = (): void => {
		seq = 0;
	};

	return { build, create, reset };
};
