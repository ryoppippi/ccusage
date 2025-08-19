import configShared from '@ccusage/config/vitest';
import Macros from 'unplugin-macros/vite';
import { defineProject, mergeConfig } from 'vitest/config';

export default mergeConfig(
	configShared,
	defineProject({
		plugins: [
			Macros({
				include: [
					'src/index.ts',
					'src/pricing-fetcher.ts',
				],
			}) as any,
		],
		test: {
			includeSource: ['./src/**/*.{js,ts}'],
		},
	}),
);
