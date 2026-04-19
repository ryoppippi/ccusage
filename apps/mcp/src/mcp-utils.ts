import type { LoadOptions } from 'ccusage/data-loader';
import { Result } from '@praha/byethrow';
import { getClaudePaths } from 'ccusage/data-loader';

export function defaultOptions(): LoadOptions {
	const result = Result.try({
		try: () => getClaudePaths(),
		catch: (error) => error,
	})();

	if (Result.isFailure(result)) {
		return { claudePath: '' } as const satisfies LoadOptions;
	}

	return { claudePath: result.value[0] ?? '' } as const satisfies LoadOptions;
}
