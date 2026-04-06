import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	stylistic: false,
	ignores: ['apps', 'packages', 'docs', 'scripts', '.claude/settings.local.json'],
});
