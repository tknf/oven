/**
 * Naming convention for Turbo Stream target ids.
 *
 * This framework has no notion of auto-deriving a prefix from a record's
 * class name, so the signature is **record-type agnostic**: `prefix` is a
 * resource name the caller specifies explicitly (e.g. `"book"`, `"chapter"`),
 * and `id` is optional, representing a "new record" case (a `new_` prefix is
 * used when it is omitted).
 */

/**
 * Builds a Turbo Stream (or similar) target id from `prefix` and `id`. When
 * `id` is given, returns `${prefix}_${id}`; when omitted, returns
 * `new_${prefix}` for the new-record case.
 *
 * `id` is percent-encoded via `encodeURIComponent`, since an id is not
 * guaranteed to always be a numeric string (e.g. a Snowflake ID) — an
 * admin-entered free-text label may contain characters unsafe for an HTML id
 * (e.g. whitespace), and `%` is itself a valid HTML id character, so the
 * encoded string can be used directly as the id value.
 */
export const domId = (prefix: string, id?: string): string =>
	id === undefined ? `new_${prefix}` : `${prefix}_${encodeURIComponent(id)}`;
