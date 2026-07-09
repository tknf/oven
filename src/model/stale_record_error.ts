/**
 * Error thrown by `updateLocked` (optimistic locking via the `lockVersion` column) when
 * the update affects zero rows, either because the target row is gone (e.g. already
 * deleted) or because of a version mismatch (another update won the race).
 * Shared by all three dialects (`SQLiteModel`/`PgModel`/`MySqlModel`), hence its own file.
 *
 * The two causes (row gone / version mismatch) both surface as the same result — a
 * zero-row UPDATE against `WHERE primaryKey = pk AND lockVersion = expectedVersion` —
 * and cannot be distinguished at the SQL level. Callers that need to tell them apart
 * should catch this error and re-`retrieve(pk)` to determine which case applies.
 */
export class StaleRecordError extends Error {
	name = "StaleRecordError";

	constructor(tableName: string, pk: unknown) {
		super(
			`Conflicted with another update (table: ${tableName}, primary key: ${String(pk)}). ` +
				"The row may have been deleted, or another update may have succeeded first since it was read.",
		);
	}
}
