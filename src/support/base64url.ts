/**
 * Shared helpers for URL-safe (Base64URL) encoding/decoding.
 *
 * Both `cookie_session_storage.ts` (storing signatures) and `csrf.ts` (storing
 * masked tokens/secrets) need to convert between "random byte sequence" and
 * "string", so this was extracted here to avoid duplicating that logic. It
 * avoids Node-only APIs (`Buffer`) and is implemented on top of `btoa`/`atob`
 * so it works in Workers, browsers, and Node alike.
 */

/** Encodes `bytes` as a Base64URL string (no `=` padding). */
export const encodeBase64Url = (bytes: Uint8Array): string => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);

	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * Decodes a Base64URL string into a `Uint8Array<ArrayBuffer>`. The return
 * type is pinned explicitly to `ArrayBuffer` (instead of the default
 * `ArrayBufferLike`) to satisfy `BufferSource` constraints such as
 * `crypto.subtle.verify` (same reason as `deriveBits` in `password.ts`; see
 * its JSDoc).
 */
export const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);

	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
};
