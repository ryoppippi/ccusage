import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		includeSource: ['src/**/*.ts'],
	},
	define: {
		'import.meta.vitest': 'undefined',
	},
});
