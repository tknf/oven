/**
 * Test helper that consolidates the boilerplate repeated every time a route
 * behind `Guard` needs to be tested (obtain an empty session -> set the
 * identity -> `commit` -> convert the `Set-Cookie` value into a Cookie
 * header) into a single function.
 *
 * Shares the same conversion as `toCookieHeader` in `guard.test.ts` (which
 * extracts the part of a `Set-Cookie` value up to the first `;`), while also
 * covering the session assembly itself.
 */
import type { SessionStorage } from "../session/session_storage.js";

export type ActingAsOptions = {
	/** Same key as `Guard`'s `identityKey`. */
	identityKey: string;
	/** Identifier to set on the session. */
	identity: string;
};

/**
 * Builds the Cookie header for an authenticated session.
 *
 * ```ts
 * const { cookie } = await actingAs(storage, { identityKey: "accountId", identity: "acc_1" });
 * const res = await app.request("/protected", { headers: { Cookie: cookie } });
 * ```
 */
export const actingAs = async (
	storage: SessionStorage,
	options: ActingAsOptions,
): Promise<{ cookie: string }> => {
	const session = await storage.get(null);
	session.set(options.identityKey, options.identity);
	const setCookie = await storage.commit(session);

	const [pair] = setCookie.split(";");
	if (!pair) throw new Error("Set-Cookie value is empty");

	return { cookie: pair };
};
