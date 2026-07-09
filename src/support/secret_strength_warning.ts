/**
 * Runtime safety net that surfaces weak `secrets` (the key-derivation input
 * strings accepted by `Encrypter`, `UrlSigner`, `DataToken`, and
 * `CookieSessionStorage`) (audit finding SEC-203).
 *
 * These classes derive keys using a single round of `SHA-256` with no
 * stretching, which is an intentional design that assumes a
 * high-entropy random value equivalent to 32 bytes is passed in; this
 * default behavior is not changed. To catch the misconfiguration of passing
 * a short, human-chosen passphrase, this **only** issues a `console.warn`
 * and never rejects.
 */

/** Minimum length (in characters) considered warning-free, based on a 32-byte random value. */
const MIN_SECRET_LENGTH = 32;

/** Guard to warn only once per `context` (prevents log flooding within the same process). */
const warnedContexts = new Set<string>();

/**
 * Warns once per `context` via `console.warn` if any of `secrets` is shorter
 * than `MIN_SECRET_LENGTH`. Never rejects (throws).
 */
export const warnWeakSecrets = (secrets: string[], context: string): void => {
	if (warnedContexts.has(context)) return;
	if (!secrets.some((secret) => secret.length < MIN_SECRET_LENGTH)) return;

	warnedContexts.add(context);
	console.warn(
		`${context}: secret is too short. Use a high-entropy random value equivalent to 32 bytes; avoid human-readable passphrases.`,
	);
};
