/**
 * Opaque cursor encoding that avoids leaking the internal ID format into the URL
 * contract. `SQLiteModel#paginate` (and the same-shaped `PgModel`/`MySqlModel`)
 * returns `nextCursor` as a raw primary key value; exposing it directly in the URL
 * would expose the ID format. Snowflake IDs reveal generation time and sequential
 * IDs allow full enumeration, so we Base64URL-encode the value to obscure its shape.
 *
 * **Intentionally unsigned**: the cursor is not secret information. Tampering with
 * it only shifts the starting point of the WHERE condition
 * (`primaryKey > cursor` / `< cursor`); the set of rows a user can reach is no
 * different from what they could already reach by paging through normally. There
 * is no threat that justifies the cost of wiring a signing key, so the scope of
 * this encoding is limited to obscuring the ID format and discouraging enumeration.
 */
import { decodeBase64Url, encodeBase64Url } from "../support/base64url.js";

const NUMBER_TAG = "n:";
const STRING_TAG = "s:";

/** Encodes a cursor into an opaque string, preserving its type with a `"n:"` (number) or `"s:"` (string) tag. */
export const encodeCursor = (cursor: string | number): string => {
	const tagged =
		typeof cursor === "number" ? `${NUMBER_TAG}${String(cursor)}` : `${STRING_TAG}${cursor}`;
	return encodeBase64Url(new TextEncoder().encode(tagged));
};

/**
 * Decodes an opaque cursor. Malformed or tampered input does not throw; it
 * returns `null` (fail-soft). Callers should treat `null` as "no cursor, i.e.
 * the first page".
 */
export const decodeCursor = (value: string): string | number | null => {
	let tagged: string;
	try {
		tagged = new TextDecoder().decode(decodeBase64Url(value));
	} catch {
		return null;
	}

	if (tagged.startsWith(NUMBER_TAG)) {
		const parsed = Number(tagged.slice(NUMBER_TAG.length));
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (tagged.startsWith(STRING_TAG)) {
		return tagged.slice(STRING_TAG.length);
	}
	return null;
};
