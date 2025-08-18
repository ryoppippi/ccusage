import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	svelte: false,
	typescript: {
		tsconfigPath: './tsconfig.json',
	},
	ignores: [
		'docs/**',
		'.lsmcp',
		'.claude/settings.local.json',
	],
}, {
	rules: {
		'test/no-importing-vitest-globals': 'error',
	},
});
