import { ryoppippi } from '@ryoppippi/eslint-config';

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = ryoppippi(
	{
		type: 'lib',
		stylistic: false,
	},
	{
		rules: {
			'test/no-importing-vitest-globals': 'error',
		},
	},
);

export default config;
