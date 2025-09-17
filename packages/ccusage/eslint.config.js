import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	svelte: false,
}, {
	rules: {
		'test/no-importing-vitest-globals': 'error',
	},
});
