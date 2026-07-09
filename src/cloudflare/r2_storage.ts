/**
 * `Storage` implementation backed by an R2 bucket.
 * When the size of data being put exceeds `MULTIPART_PART_SIZE_BYTES` (100 MiB, a unit that
 * fits within R2's part size constraint of [5 MiB, 5 GiB] and is generous enough for large
 * future uploads), it automatically switches from a regular put to a Multipart Upload
 * (`createMultipartUpload`/`uploadPart`/`complete`). Centralizing this decision here means
 * callers (domain-specific wrappers) never need to be aware of whether their data is large
 * (https://developers.cloudflare.com/r2/objects/upload-objects/#multipart-upload-details).
 */
import { Storage, type StorageObject } from "../storage/storage.js";

/** Threshold for switching to Multipart Upload; also the size of each part once switched. */
const MULTIPART_PART_SIZE_BYTES = 100 * 1024 * 1024;

/** Type of a part body accepted by `R2MultipartUpload.uploadPart`. */
type PartData = Blob | ArrayBuffer | Uint8Array;

/** `Storage` implementation backed by an R2 bucket. */
export class R2Storage extends Storage {
	constructor(private readonly bucket: R2Bucket) {
		super();
	}

	async put(
		key: string,
		data: Blob | ReadableStream | ArrayBuffer,
		contentType: string,
	): Promise<void> {
		const httpMetadata = { contentType };

		if (data instanceof ReadableStream) {
			await this.putStream(key, data, httpMetadata);
			return;
		}

		const size = data instanceof Blob ? data.size : data.byteLength;
		if (size <= MULTIPART_PART_SIZE_BYTES) {
			await this.bucket.put(key, data, { httpMetadata });
			return;
		}
		await this.putMultipart(key, httpMetadata, R2Storage.sliceParts(data, size));
	}

	async get(key: string): Promise<StorageObject | null> {
		const object = await this.bucket.get(key);
		if (!object) return null;
		return { body: object.body, contentType: object.httpMetadata?.contentType ?? null };
	}

	async delete(key: string): Promise<void> {
		await this.bucket.delete(key);
	}

	/**
	 * Looks ahead only the first two parts of the stream: if a second part does not exist
	 * (i.e. the data is at or below the threshold), does a regular put; if it does exist
	 * (i.e. above the threshold), routes to Multipart Upload.
	 */
	private async putStream(
		key: string,
		stream: ReadableStream,
		httpMetadata: R2HTTPMetadata,
	): Promise<void> {
		const parts = R2Storage.chunk(stream.getReader(), MULTIPART_PART_SIZE_BYTES);
		const first = await parts.next();
		if (first.done) {
			await this.bucket.put(key, new Uint8Array(0), { httpMetadata });
			return;
		}

		const second = await parts.next();
		if (second.done) {
			await this.bucket.put(key, first.value, { httpMetadata });
			return;
		}

		await this.putMultipart(
			key,
			httpMetadata,
			(async function* () {
				yield first.value;
				yield second.value;
				yield* parts;
			})(),
		);
	}

	/** Creates a Multipart Upload, uploads `parts` in order, and completes it. Aborts on failure. */
	private async putMultipart(
		key: string,
		httpMetadata: R2HTTPMetadata,
		parts: AsyncIterable<PartData>,
	): Promise<void> {
		const upload = await this.bucket.createMultipartUpload(key, { httpMetadata });
		try {
			const uploaded: R2UploadedPart[] = [];
			let partNumber = 1;
			for await (const part of parts) {
				uploaded.push(await upload.uploadPart(partNumber, part));
				partNumber += 1;
			}
			await upload.complete(uploaded);
		} catch (error) {
			await upload.abort();
			throw error;
		}
	}

	/** Splits a `Blob`/`ArrayBuffer` of known size into fixed-size parts. */
	private static async *sliceParts(
		data: Blob | ArrayBuffer,
		size: number,
	): AsyncGenerator<PartData> {
		for (let offset = 0; offset < size; offset += MULTIPART_PART_SIZE_BYTES) {
			const end = Math.min(offset + MULTIPART_PART_SIZE_BYTES, size);
			yield data instanceof Blob ? data.slice(offset, end) : data.slice(offset, end);
		}
	}

	/** Reads fixed-size byte chunks from a stream (only the final chunk may vary in size). */
	private static async *chunk(
		reader: ReadableStreamDefaultReader<Uint8Array>,
		size: number,
	): AsyncGenerator<Uint8Array> {
		let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);
		while (true) {
			const { done, value } = await reader.read();
			if (value) buffer = R2Storage.concat(buffer, value);
			while (buffer.byteLength >= size) {
				yield buffer.slice(0, size);
				buffer = buffer.slice(size);
			}
			if (done) {
				if (buffer.byteLength > 0) yield buffer;
				return;
			}
		}
	}

	private static concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
		const merged = new Uint8Array(a.byteLength + b.byteLength);
		merged.set(a, 0);
		merged.set(b, a.byteLength);
		return merged;
	}
}
