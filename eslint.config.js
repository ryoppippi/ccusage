import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	ignores: [
		'apps',
		'packages',
		'docs',
		'.claude/settings.local.json',
	],
});
