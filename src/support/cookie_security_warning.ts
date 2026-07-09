/**
 * Runtime safety net that surfaces cookies running with an unset `secure`
 * attribute in a production-like runtime (audit finding SEC-202).
 *
 * oven's cookie-related classes (`SessionStorage`, `RememberToken`, etc.) do
 * not have a default value for `secure` (an intentional design choice that
 * favors local HTTP development). This default behavior itself is not
 * changed; instead, when `secure` is left unset and the runtime can be
 * determined to be production-like, this **warns once** via `console.warn`
 * (it never rejects the request or injects a default value).
 *
 * The production check is done in a runtime-agnostic, fail-safe way: it
 * reads `process.env.NODE_ENV === "production"` via `globalThis` and stays
 * silent whenever this cannot be determined (`process` doesn't exist, or has
 * an unexpected shape). It avoids `as unknown as`/`any`/non-null assertion,
 * using the same "progressively narrow `unknown` via `typeof`/`in`" pattern
 * as `parsePayload` in `data_token.ts`.
 */

/** Guard to warn only once per `context` (prevents log flooding within the same process). */
const warnedContexts = new Set<string>();

/** Type-safely reads `globalThis.process.env.NODE_ENV`. Returns `undefined` if it cannot be determined. */
const readNodeEnv = (): string | undefined => {
	const globalRecord: unknown = globalThis;
	if (typeof globalRecord !== "object" || globalRecord === null) return undefined;
	if (!("process" in globalRecord)) return undefined;

	const maybeProcess = globalRecord.process;
	if (typeof maybeProcess !== "object" || maybeProcess === null) return undefined;
	if (!("env" in maybeProcess)) return undefined;

	const maybeEnv = maybeProcess.env;
	if (typeof maybeEnv !== "object" || maybeEnv === null) return undefined;
	if (!("NODE_ENV" in maybeEnv)) return undefined;

	const nodeEnv = maybeEnv.NODE_ENV;
	return typeof nodeEnv === "string" ? nodeEnv : undefined;
};

/**
 * Warns once per `context` via `console.warn` when `secure` is unset
 * (`undefined`) and the runtime is determined to be production-like
 * (`NODE_ENV === "production"`). Does nothing if `secure` is explicitly set,
 * or if the runtime cannot be determined to be production-like.
 */
export const warnInsecureCookieInProduction = (
	secure: boolean | undefined,
	context: string,
): void => {
	if (secure !== undefined) return;
	if (warnedContexts.has(context)) return;
	if (readNodeEnv() !== "production") return;

	warnedContexts.add(context);
	console.warn(
		`${context}: cookie's secure attribute is not set. Set secure: true explicitly in production.`,
	);
};
