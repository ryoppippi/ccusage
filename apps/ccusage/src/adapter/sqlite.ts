import type { SqliteDatabase } from '@ccusage/internal/sqlite';
import { withSqliteDatabase } from '@ccusage/internal/sqlite';
import { Result } from '@praha/byethrow';
import { logger } from '../logger.ts';

export function loadReadonlySqliteRows<T>(
	dbPath: string | null | undefined,
	errorMessage: string,
	readRows: (db: SqliteDatabase) => T[],
): T[] {
	if (dbPath == null) {
		return [];
	}

	const result = Result.try({
		try: () => withSqliteDatabase(dbPath, { readOnly: true }, readRows, logger.warn),
		catch: (error) => error,
	})();
	if (Result.isFailure(result)) {
		logger.warn(errorMessage, result.error);
		return [];
	}
	return result.value ?? [];
}
