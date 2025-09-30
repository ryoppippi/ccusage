import { ryoppippi } from '@ryoppippi/eslint-config';

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = ryoppippi({
	type: 'lib',
	ignores: [
		'packages',
		'package.json',
		'config-schema.json',
	],
}, {
	rules: {
		'test/no-importing-vitest-globals': 'error',
	},
});

export default config;
