import configShared from '@ccusage/config/vitest';
import { defineProject, mergeConfig } from 'vitest/config';

export default mergeConfig(
	configShared,
	defineProject({
		test: {
			includeSource: ['./src/**/*.{js,ts}'],
		},
	}),
);
