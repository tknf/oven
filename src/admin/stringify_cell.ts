/**
 * Converts one table cell value into a display string. Shared by the resource
 * list screen (`admin_resource_list_view.tsx`) and its CSV export
 * (`admin_resource_csv_view.ts`), so both always render the exact same text
 * for a given cell (e.g. a boolean column reads "true"/"false" in both
 * places). Since `String(unknown)` can produce `"[object Object]"` when
 * passed an object, only string/number/bigint/boolean are converted;
 * anything else (object, null, undefined, etc.) becomes an empty string.
 */
export const stringifyCell = (value: unknown): string => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
		return String(value);
	}
	return "";
};
