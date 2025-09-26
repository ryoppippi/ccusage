import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'app',
	ignores: [
		'package.json',
	],
	markdown: true,
});
