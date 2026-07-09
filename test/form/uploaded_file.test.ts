/**
 * Verifies the uploaded-file validation helpers (`validateUploadedFile`/`sniffMimeType`).
 */
import { Hono } from "hono";
import { languageDetector } from "hono/language";
import { describe, expect, test } from "vite-plus/test";
import { localizeUploadedFileError } from "../../src/form/upload_validation_messages.js";
import { sniffMimeType, validateUploadedFile } from "../../src/form/uploaded_file.js";

describe("validateUploadedFile", () => {
	test("a non-File value becomes not-a-file", () => {
		expect(validateUploadedFile("not-a-file")).toEqual({
			ok: false,
			reason: "not-a-file",
			message: "Please select a file.",
		});
		expect(validateUploadedFile(null).ok).toBe(false);
	});

	test("without constraints, only the File type check applies and it becomes ok", () => {
		const file = new File(["hello"], "hello.txt", { type: "text/plain" });
		const result = validateUploadedFile(file);
		expect(result).toEqual({ ok: true, file });
	});

	test("exceeding maxSizeBytes becomes too-large", () => {
		const file = new File(["0123456789"], "big.txt", { type: "text/plain" });
		const result = validateUploadedFile(file, { maxSizeBytes: 5 });
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("too-large");
			expect(result.message).toContain("5");
			expect(result.message).toContain("10");
		}
	});

	test("within maxSizeBytes it becomes ok", () => {
		const file = new File(["ab"], "small.txt", { type: "text/plain" });
		const result = validateUploadedFile(file, { maxSizeBytes: 5 });
		expect(result).toEqual({ ok: true, file });
	});

	test("an exact match in allowedMimeTypes becomes ok", () => {
		const file = new File(["x"], "a.png", { type: "image/png" });
		const result = validateUploadedFile(file, { allowedMimeTypes: ["image/png", "image/jpeg"] });
		expect(result).toEqual({ ok: true, file });
	});

	test("a wildcard match in allowedMimeTypes becomes ok", () => {
		const file = new File(["x"], "a.gif", { type: "image/gif" });
		const result = validateUploadedFile(file, { allowedMimeTypes: ["image/*"] });
		expect(result).toEqual({ ok: true, file });
	});

	test("matching none of allowedMimeTypes becomes unsupported-type", () => {
		const file = new File(["x"], "a.pdf", { type: "application/pdf" });
		const result = validateUploadedFile(file, { allowedMimeTypes: ["image/*"] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("unsupported-type");
	});

	test("absorbs case differences in the declared MIME type", () => {
		const file = new File(["x"], "a.png", { type: "IMAGE/PNG" });
		const result = validateUploadedFile(file, { allowedMimeTypes: ["image/png"] });
		expect(result).toEqual({ ok: true, file });

		const wildcardResult = validateUploadedFile(file, { allowedMimeTypes: ["Image/*"] });
		expect(wildcardResult).toEqual({ ok: true, file });
	});

	test("maxSizeBytes: 0 rejects any non-empty file but accepts a 0-byte file", () => {
		const nonEmpty = new File(["x"], "a.txt", { type: "text/plain" });
		const rejected = validateUploadedFile(nonEmpty, { maxSizeBytes: 0 });
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.reason).toBe("too-large");

		const empty = new File([], "empty.txt", { type: "text/plain" });
		const accepted = validateUploadedFile(empty, { maxSizeBytes: 0 });
		expect(accepted).toEqual({ ok: true, file: empty });
	});

	test("an empty allowedMimeTypes array matches nothing and rejects as unsupported-type", () => {
		const file = new File(["x"], "a.png", { type: "image/png" });
		const result = validateUploadedFile(file, { allowedMimeTypes: [] });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("unsupported-type");
	});
});

describe("sniffMimeType", () => {
	test("detects the PNG magic bytes", async () => {
		const file = new File(
			[new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
			"a.png",
		);
		expect(await sniffMimeType(file)).toBe("image/png");
	});

	test("detects the JPEG magic bytes", async () => {
		const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])], "a.jpg");
		expect(await sniffMimeType(file)).toBe("image/jpeg");
	});

	test("detects the GIF magic bytes", async () => {
		const file = new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], "a.gif");
		expect(await sniffMimeType(file)).toBe("image/gif");
	});

	test("detects the WebP magic bytes", async () => {
		const bytes = new Uint8Array([
			0x52,
			0x49,
			0x46,
			0x46, // "RIFF"
			0x00,
			0x00,
			0x00,
			0x00, // file size (irrelevant to detection)
			0x57,
			0x45,
			0x42,
			0x50, // "WEBP"
		]);
		const file = new File([bytes], "a.webp");
		expect(await sniffMimeType(file)).toBe("image/webp");
	});

	test("detects the PDF magic bytes", async () => {
		const file = new File(
			[new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34])],
			"a.pdf",
		);
		expect(await sniffMimeType(file)).toBe("application/pdf");
	});

	test("an unknown byte sequence becomes null", async () => {
		const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])], "unknown.bin");
		expect(await sniffMimeType(file)).toBeNull();
	});

	test("doesn't throw even for a file shorter than 5 bytes", async () => {
		const file = new File([new Uint8Array([0x89, 0x50])], "short.bin");
		await expect(sniffMimeType(file)).resolves.toBeNull();
	});

	test("doesn't throw even for an empty file", async () => {
		const file = new File([], "empty.bin");
		await expect(sniffMimeType(file)).resolves.toBeNull();
	});

	/**
	 * Documents a known gap: `sniffMimeType` has no magic-byte signature for
	 * SVG/XML/text formats, so it cannot distinguish an SVG payload (which can
	 * carry a `<script>` and enable stored XSS when served back to a browser)
	 * from any other undetectable format. A caller that combines a wildcard
	 * MIME allowlist (`image/*`) with `validateUploadedFile` alone accepts the
	 * file purely off the spoofable declared `file.type`, unless it explicitly
	 * rejects `null` sniff results or the `image/svg+xml` type itself.
	 */
	test("cannot detect SVG magic bytes, so a spoofed image/svg+xml file passes a wildcard MIME allowlist unchecked", async () => {
		const svgFile = new File(["<svg><script>alert(1)</script></svg>"], "payload.svg", {
			type: "image/svg+xml",
		});

		expect(await sniffMimeType(svgFile)).toBeNull();
		expect(validateUploadedFile(svgFile, { allowedMimeTypes: ["image/*"] })).toEqual({
			ok: true,
			file: svgFile,
		});
	});
});

describe("localizeUploadedFileError", () => {
	test("falls back to the English default message when no language is detected", async () => {
		const result = validateUploadedFile(null);
		if (result.ok) throw new Error("expected failure");

		const app = new Hono();
		app.get("/", (c) => c.text(localizeUploadedFileError(c, result)));

		const res = await app.request("/");
		expect(await res.text()).toBe("Please select a file.");
	});

	test("uses the Japanese message when the language is ja", async () => {
		const file = new File(["0123456789"], "big.txt", { type: "text/plain" });
		const result = validateUploadedFile(file, { maxSizeBytes: 5 });
		if (result.ok) throw new Error("expected failure");

		const app = new Hono();
		app.use(languageDetector({ supportedLanguages: ["ja", "en"], fallbackLanguage: "en" }));
		app.get("/", (c) => c.text(localizeUploadedFileError(c, result)));

		const res = await app.request("/", { headers: { "Accept-Language": "ja" } });
		expect(await res.text()).toBe("ファイルサイズは5バイト以内にしてください（現在: 10バイト）。");
	});
});
