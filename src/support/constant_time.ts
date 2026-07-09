/**
 * Shared helper for timing-attack mitigation.
 *
 * Places that compare secret values against each other — such as `csrf.ts`
 * (mask token verification) and `url_signer.ts` (signature verification) —
 * must always go through this function, since a plain `===` comparison can
 * leak the position of the first difference through timing.
 */

/** Constant-time byte array comparison to avoid timing attacks. */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
	if (a.length !== b.length) return false;

	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
	return diff === 0;
};
