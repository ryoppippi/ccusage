import type { LoadOptions } from 'ccusage/data-loader';
import { getClaudePaths } from 'ccusage/data-loader';

export function defaultOptions(): LoadOptions {
	try {
		const paths = getClaudePaths();
		return { claudePath: paths[0] ?? '' } as const satisfies LoadOptions;
	} catch {
		return { claudePath: '' } as const satisfies LoadOptions;
	}
}
