import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	svelte: false,
	ignores: [
		'apps',
		'packages',
		'docs',
		'.lsmcp',
		'.claude/settings.local.json',
	],
});
