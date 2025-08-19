import Macros from 'unplugin-macros/vite';
import { defineProject, mergeConfig } from 'vitest/config';
import configShared from '../../vitest.shared.config';

export default mergeConfig(
	configShared,
	defineProject({
		plugins: [
			Macros({
				include: [
					'src/index.ts',
					'src/pricing-fetcher.ts',
				],
			}),
		],
		test: {
			includeSource: ['./src/**/*.{js,ts}'],
		},
	}),
);
