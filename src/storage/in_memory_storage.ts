/**
 * `Storage` implementation for development and testing. It only holds values
 * in-process on a `Map` and does not persist them.
 *
 * The `Blob`/`ReadableStream`/`ArrayBuffer` passed to `put` is normalized and
 * held as a `Uint8Array`, and `get` creates and returns a new `ReadableStream`
 * each time (so the same content can be read multiple times).
 */
import type {
	MultipartUpload,
	MultipartUploader,
	MultipartUploadResult,
	UploadedPart,
} from "./multipart_uploader.js";
import { Storage, type StorageObject } from "./storage.js";

type Entry = {
	bytes: Uint8Array;
	contentType: string;
};

type PendingUpload = {
	key: string;
	contentType: string;
	parts: Map<number, { bytes: Uint8Array; etag: string }>;
};

/** In-memory `Storage` backend intended for development and testing only. */
export class InMemoryStorage extends Storage implements MultipartUploader {
	private readonly store = new Map<string, Entry>();
	private readonly uploads = new Map<string, PendingUpload>();

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		this.store.set(key, { bytes: await InMemoryStorage.toBytes(data), contentType });
	}

	async get(key: string): Promise<StorageObject | null> {
		const entry = this.store.get(key);
		if (!entry) return null;

		const bytes = entry.bytes;
		return {
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
			contentType: entry.contentType,
		};
	}

	async delete(key: string): Promise<void> {
		this.store.delete(key);
	}

	createMultipartUpload = async (key: string, contentType: string): Promise<MultipartUpload> => {
		const uploadId = crypto.randomUUID();
		this.uploads.set(uploadId, { key, contentType, parts: new Map() });
		return { key, uploadId };
	};

	uploadPart = async (
		upload: MultipartUpload,
		partNumber: number,
		body: Blob | ReadableStream | ArrayBuffer,
	): Promise<UploadedPart> => {
		if (!Number.isSafeInteger(partNumber) || partNumber < 1) {
			throw new RangeError("partNumber must be a positive safe integer");
		}
		const reference = { ...upload };
		this.pendingUpload(reference);
		const bytes = (await InMemoryStorage.toBytes(body)).slice();
		/** Recheck after reading: another operation may have completed or aborted the upload. */
		const pending = this.pendingUpload(reference);
		const etag = crypto.randomUUID();
		pending.parts.set(partNumber, { bytes, etag });
		return { partNumber, etag };
	};

	completeMultipartUpload = async (
		upload: MultipartUpload,
		parts: UploadedPart[],
	): Promise<MultipartUploadResult> => {
		const pending = this.pendingUpload(upload);
		if (parts.length === 0) throw new Error("At least one uploaded part is required");
		let previousPartNumber = 0;
		const selected = parts.map(({ partNumber, etag }) => {
			if (partNumber <= previousPartNumber) {
				throw new Error("Parts must be in ascending order without duplicates");
			}
			const part = pending.parts.get(partNumber);
			if (!part || part.etag !== etag) throw new Error("Uploaded part metadata does not match");
			previousPartNumber = partNumber;
			return part.bytes;
		});
		const bytes = new Uint8Array(selected.reduce((size, part) => size + part.byteLength, 0));
		let offset = 0;
		for (const part of selected) {
			bytes.set(part, offset);
			offset += part.byteLength;
		}
		this.store.set(upload.key, { bytes, contentType: pending.contentType });
		this.uploads.delete(upload.uploadId);
		return { size: bytes.byteLength };
	};

	abortMultipartUpload = async (upload: MultipartUpload): Promise<void> => {
		const pending = this.uploads.get(upload.uploadId);
		if (!pending) return;
		this.pendingUpload(upload);
		this.uploads.delete(upload.uploadId);
	};

	private pendingUpload = (upload: MultipartUpload): PendingUpload => {
		const pending = this.uploads.get(upload.uploadId);
		if (!pending || pending.key !== upload.key) throw new Error("Multipart upload not found");
		return pending;
	};

	private static async toBytes(data: Blob | ReadableStream | ArrayBuffer): Promise<Uint8Array> {
		if (data instanceof ArrayBuffer) return new Uint8Array(data);
		if (data instanceof ReadableStream)
			return new Uint8Array(await new Response(data).arrayBuffer());
		return new Uint8Array(await data.arrayBuffer());
	}
}
