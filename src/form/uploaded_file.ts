/**
 * Upload validation helpers for `File` values. `form.ts`'s Standard
 * Schema-based validation handles type conversion/issue creation for
 * string/File values, but doesn't validate the "content" of a File (size
 * limit, MIME), so that's supplemented here. The synchronous
 * `validateUploadedFile` (size + declared MIME) and the asynchronous
 * `sniffMimeType` (magic-byte detection) are provided as two orthogonal pure
 * functions (not classes, since they hold no state or dependencies — the
 * "single idiom = class" rule targets things that do).
 */

/** Constraints imposed by `validateUploadedFile`. Omitted axes are not validated. */
export type UploadedFileConstraints = {
	/** The maximum allowed byte count. */
	maxSizeBytes?: number;
	/** Allowed MIME types. Accepts either an exact match (case-insensitive) or a `"image/*"`-style wildcard. */
	allowedMimeTypes?: string[];
};

/**
 * A validation failure result from `validateUploadedFile`, discriminated by `reason`. Each
 * variant carries the data needed to localize its own message (e.g. `maxSizeBytes`/`size` for
 * `too-large`), in addition to the default English `message`. Use `localizeUploadedFileError`
 * (in `upload_validation_messages.ts`) to render the message in another language.
 */
export type UploadedFileValidationFailure =
	| { ok: false; reason: "not-a-file"; message: string }
	| { ok: false; reason: "too-large"; maxSizeBytes: number; size: number; message: string }
	| { ok: false; reason: "unsupported-type"; type: string; message: string };

/** The result of `validateUploadedFile`. */
export type UploadedFileValidation = { ok: true; file: File } | UploadedFileValidationFailure;

/** Whether `mimeType` (already lowercased) matches `pattern` (either a `"image/*"`-style wildcard or an exact match). */
const matchesMimePattern = (mimeType: string, pattern: string): boolean => {
	const lowerPattern = pattern.toLowerCase();
	if (lowerPattern.endsWith("/*")) return mimeType.startsWith(lowerPattern.slice(0, -1));
	return mimeType === lowerPattern;
};

/**
 * Validates whether `value` is a `File` satisfying `constraints`.
 * - `not-a-file` if `value instanceof File` is false.
 * - `too-large` if `constraints.maxSizeBytes` is given and `file.size` exceeds it.
 * - `unsupported-type` if `constraints.allowedMimeTypes` is given and
 *   `file.type` (lowercased) matches none of the entries (`"image/*"`-style
 *   entries match by prefix, others by exact match).
 * - When `constraints` is omitted (or each axis is), only the File type check runs.
 *
 * **Note**: `file.type` is a client-declared value the browser guesses from
 * the filename extension etc., and can be spoofed. Combine with
 * `sniffMimeType` when strict content-based judgment is required.
 */
export const validateUploadedFile = (
	value: unknown,
	constraints?: UploadedFileConstraints,
): UploadedFileValidation => {
	if (!(value instanceof File)) {
		return { ok: false, reason: "not-a-file", message: "Please select a file." };
	}

	const { maxSizeBytes, allowedMimeTypes } = constraints ?? {};

	if (maxSizeBytes !== undefined && value.size > maxSizeBytes) {
		return {
			ok: false,
			reason: "too-large",
			maxSizeBytes,
			size: value.size,
			message: `File size must not exceed ${maxSizeBytes} bytes (current: ${value.size} bytes).`,
		};
	}

	if (allowedMimeTypes !== undefined) {
		const mimeType = value.type.toLowerCase();
		const matched = allowedMimeTypes.some((pattern) => matchesMimePattern(mimeType, pattern));
		if (!matched) {
			return {
				ok: false,
				reason: "unsupported-type",
				type: value.type,
				message: `Unsupported file type (${value.type || "unknown"}).`,
			};
		}
	}

	return { ok: true, file: value };
};

/**
 * Detection table (leading-byte magic numbers). `bytes` is the leading byte
 * sequence to check for, `mimeType` is the value returned on a match. Formats
 * like `webp`, which check two offset ranges, don't fit this simple table and
 * are handled individually inside `sniffMimeType`.
 */
const MAGIC_BYTE_SIGNATURES: ReadonlyArray<{ bytes: number[]; mimeType: string }> = [
	{ bytes: [0x89, 0x50, 0x4e, 0x47], mimeType: "image/png" },
	{ bytes: [0xff, 0xd8, 0xff], mimeType: "image/jpeg" },
	{ bytes: [0x47, 0x49, 0x46, 0x38], mimeType: "image/gif" },
	{ bytes: [0x25, 0x50, 0x44, 0x46], mimeType: "application/pdf" },
];

/** Whether `view` starts with `bytes` (`false` if `view` is shorter than `bytes`). */
const startsWithBytes = (view: Uint8Array, bytes: number[]): boolean => {
	if (view.length < bytes.length) return false;
	return bytes.every((byte, index) => view[index] === byte);
};

/**
 * Determines the actual MIME type of `file` from its leading bytes (magic
 * bytes). Supports only 5 formats — PNG, JPEG, GIF, WebP, PDF — intentionally
 * minimal (text-based formats have no magic bytes, so they're excluded from
 * detection).
 *
 * - PNG: `89 50 4E 47`
 * - JPEG: `FF D8 FF`
 * - GIF: `47 49 46 38` ("GIF8")
 * - WebP: bytes 0-3 are "RIFF" and bytes 8-11 are "WEBP"
 * - PDF: `25 50 44 46` ("%PDF")
 *
 * Returns `null` when none match (an unknown format, or fewer than 5 bytes —
 * not enough to determine). `null` means "undeterminable"; whether to treat
 * that as "reject as unknown format" or "allow" is left to the calling app.
 */
export const sniffMimeType = async (file: File): Promise<string | null> => {
	const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());

	for (const { bytes, mimeType } of MAGIC_BYTE_SIGNATURES) {
		if (startsWithBytes(head, bytes)) return mimeType;
	}

	const isRiff = startsWithBytes(head, [0x52, 0x49, 0x46, 0x46]);
	const isWebp = head.length >= 12 && startsWithBytes(head.slice(8, 12), [0x57, 0x45, 0x42, 0x50]);
	if (isRiff && isWebp) return "image/webp";

	return null;
};
