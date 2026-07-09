/**
 * i18n catalog and helper for localizing `UploadedFileValidationFailure` messages. This
 * reuses the generic `Translator`/`Catalog`/`CatalogBundle` machinery from `i18n/i18n.ts`
 * (see that module's doc comment inviting apps to build their own catalogs), the same way
 * `admin/admin_catalog.ts` does for the admin panel's own UI labels.
 *
 * Scope: only the three failure reasons `validateUploadedFile` can return (`not-a-file`,
 * `too-large`, `unsupported-type`), plus a small `unknown` placeholder word substituted for
 * an empty `file.type`.
 */
import type { Context } from "hono";
import type { Catalog, CatalogBundle } from "../i18n/i18n.js";
import { Translator } from "../i18n/i18n.js";
import type { UploadedFileValidationFailure } from "./uploaded_file.js";

/** English catalog (default and fallback language). */
const en = {
	"upload.notAFile": "Please select a file.",
	"upload.tooLarge": "File size must not exceed {max} bytes (current: {size} bytes).",
	"upload.unsupportedType": "Unsupported file type ({type}).",
	"upload.unknownType": "unknown",
} satisfies Catalog;

/** The key set of the upload validation catalog (`en` is authoritative; every other catalog mirrors the same keys). */
export type UploadValidationCatalog = typeof en;

/** Japanese catalog. */
const ja = {
	"upload.notAFile": "ファイルを指定してください。",
	"upload.tooLarge": "ファイルサイズは{max}バイト以内にしてください（現在: {size}バイト）。",
	"upload.unsupportedType": "対応していないファイル形式です（{type}）。",
	"upload.unknownType": "不明",
} satisfies UploadValidationCatalog;

/** Simplified Chinese catalog. */
const zh = {
	"upload.notAFile": "请选择一个文件。",
	"upload.tooLarge": "文件大小不得超过 {max} 字节（当前：{size} 字节）。",
	"upload.unsupportedType": "不支持的文件类型（{type}）。",
	"upload.unknownType": "未知",
} satisfies UploadValidationCatalog;

/** Spanish catalog. */
const es = {
	"upload.notAFile": "Por favor, seleccione un archivo.",
	"upload.tooLarge": "El tamaño del archivo no debe superar {max} bytes (actual: {size} bytes).",
	"upload.unsupportedType": "Tipo de archivo no admitido ({type}).",
	"upload.unknownType": "desconocido",
} satisfies UploadValidationCatalog;

/** French catalog. */
const fr = {
	"upload.notAFile": "Veuillez sélectionner un fichier.",
	"upload.tooLarge":
		"La taille du fichier ne doit pas dépasser {max} octets (actuel : {size} octets).",
	"upload.unsupportedType": "Type de fichier non pris en charge ({type}).",
	"upload.unknownType": "inconnu",
} satisfies UploadValidationCatalog;

/** German catalog. */
const de = {
	"upload.notAFile": "Bitte wählen Sie eine Datei aus.",
	"upload.tooLarge": "Die Dateigröße darf {max} Byte nicht überschreiten (aktuell: {size} Byte).",
	"upload.unsupportedType": "Nicht unterstützter Dateityp ({type}).",
	"upload.unknownType": "unbekannt",
} satisfies UploadValidationCatalog;

/** Brazilian Portuguese catalog. */
const pt = {
	"upload.notAFile": "Selecione um arquivo.",
	"upload.tooLarge": "O tamanho do arquivo não pode exceder {max} bytes (atual: {size} bytes).",
	"upload.unsupportedType": "Tipo de arquivo não suportado ({type}).",
	"upload.unknownType": "desconhecido",
} satisfies UploadValidationCatalog;

/** Russian catalog. */
const ru = {
	"upload.notAFile": "Пожалуйста, выберите файл.",
	"upload.tooLarge": "Размер файла не должен превышать {max} байт (текущий: {size} байт).",
	"upload.unsupportedType": "Неподдерживаемый тип файла ({type}).",
	"upload.unknownType": "неизвестно",
} satisfies UploadValidationCatalog;

/** Korean catalog. */
const ko = {
	"upload.notAFile": "파일을 선택해 주세요.",
	"upload.tooLarge": "파일 크기는 {max}바이트 이하여야 합니다 (현재: {size}바이트).",
	"upload.unsupportedType": "지원하지 않는 파일 형식입니다 ({type}).",
	"upload.unknownType": "알 수 없음",
} satisfies UploadValidationCatalog;

/** Arabic catalog (right-to-left). */
const ar = {
	"upload.notAFile": "الرجاء اختيار ملف.",
	"upload.tooLarge": "يجب ألا يتجاوز حجم الملف {max} بايت (الحالي: {size} بايت).",
	"upload.unsupportedType": "نوع ملف غير مدعوم ({type}).",
	"upload.unknownType": "غير معروف",
} satisfies UploadValidationCatalog;

/**
 * The upload validation catalog bundle. `en` is the default/fallback; `ja`, `zh`, `es`,
 * `fr`, `de`, `pt`, `ru`, `ko`, and `ar` are matched against `c.get("language")`
 * (two-letter base codes, to maximize matches from `languageDetector`).
 */
export const uploadValidationCatalogBundle: CatalogBundle<UploadValidationCatalog> = {
	en,
	ja,
	zh,
	es,
	fr,
	de,
	pt,
	ru,
	ko,
	ar,
};

/** The translator for upload validation messages, falling back to `en` when the detected language isn't in the bundle. */
export const uploadValidationTranslator = new Translator(uploadValidationCatalogBundle, {
	fallbackLanguage: "en",
});

/**
 * Renders `failure` (a `UploadedFileValidationFailure` from `validateUploadedFile`) as
 * localized text via `c.get("language")`, instead of the English default carried on
 * `failure.message`.
 */
export const localizeUploadedFileError = (
	c: Context,
	failure: UploadedFileValidationFailure,
): string => {
	const t = uploadValidationTranslator.t;
	switch (failure.reason) {
		case "not-a-file":
			return t(c, "upload.notAFile");
		case "too-large":
			return t(c, "upload.tooLarge", { max: failure.maxSizeBytes, size: failure.size });
		case "unsupported-type": {
			const type = failure.type || t(c, "upload.unknownType");
			return t(c, "upload.unsupportedType", { type });
		}
	}
};
