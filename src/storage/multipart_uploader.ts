/** Serializable reference to an upload in the backend that created it. Not an authorization token. */
export type MultipartUpload = {
	key: string;
	uploadId: string;
};

/** Completion metadata for one part. Treat the ETag as opaque and retain the latest upload result. */
export type UploadedPart = {
	partNumber: number;
	etag: string;
};

/**
 * Optional capability for uploads spanning multiple requests, independent of `Storage`.
 * Callers retain the upload reference and part metadata between requests. Backend errors
 * propagate; failed operations do not automatically abort the upload. Applications own
 * authorization, input validation, request limits, retries, and abandoned-upload cleanup.
 */
export interface MultipartUploader {
	/** Starts an upload without changing the stored object. Content type is set at creation. */
	createMultipartUpload(key: string, contentType: string): Promise<MultipartUpload>;

	/** Uploads or replaces a positive numbered part. Backend part-size/count limits apply. */
	uploadPart(
		upload: MultipartUpload,
		partNumber: number,
		body: Blob | ReadableStream | ArrayBuffer,
	): Promise<UploadedPart>;

	/**
	 * Publishes the selected parts, replacing an existing object at the key.
	 * Supply a nonempty list of current part metadata in ascending order without duplicates.
	 * Success resolves to void, matching `Storage.put`; the upload can no longer accept parts.
	 */
	completeMultipartUpload(upload: MultipartUpload, parts: UploadedPart[]): Promise<void>;

	/** Discards pending parts without deleting an already stored object. */
	abortMultipartUpload(upload: MultipartUpload): Promise<void>;
}
