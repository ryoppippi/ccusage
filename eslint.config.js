import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	stylistic: false,
	ignores: ['apps', 'packages', 'docs', '.claude/settings.local.json', 'OMNI_PLAN.md'],
});
