import { ryoppippi } from '@ryoppippi/eslint-config';

/** @type {import('eslint').Linter.FlatConfig[]} */
const config = ryoppippi({
	type: 'app',
	stylistic: false,
});

export default config;
