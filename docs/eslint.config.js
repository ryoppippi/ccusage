import { ryoppippi } from '@ryoppippi/eslint-config';

export default ryoppippi({
	type: 'lib',
	svelte: false,
	markdown: true,
	ignores: [
		'.vitepress/dist',
		'.vitepress/cache',
		'api/**',
		'public/**',
		'update-api-index.ts', // Script file with specific patterns
	],
});
