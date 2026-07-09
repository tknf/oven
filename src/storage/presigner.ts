/**
 * Interface representing the capability of issuing presigned GET URLs.
 *
 * This is deliberately kept separate from `Storage`. An R2 binding cannot
 * presign on its own (it needs separate credentials such as an S3-compatible
 * endpoint plus access keys, which the operations exposed by `R2Bucket` alone
 * cannot satisfy). In other words, "having a `Storage`" and "being able to
 * issue presigned URLs" are independent capabilities, and this asymmetry is
 * expressed as a type (interface) rather than a class hierarchy.
 *
 * The framework's single idiom is abstract base class + inheritance, but a
 * capability can be composed into multiple implementations (e.g. a future
 * `S3Storage` could implement both `Storage` and `Presigner`), so it is
 * defined as an interface rather than through inheritance.
 */
export interface Presigner {
	/** Issues a presigned GET URL for `key`. It expires after `expiresInSeconds`. */
	presignGet(key: string, expiresInSeconds: number): Promise<string>;
}
