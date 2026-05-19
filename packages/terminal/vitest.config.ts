import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		globals: true,
		includeSource: ['src/**/*.ts'],
	},
	define: {
		'import.meta.vitest': 'undefined',
	},
});
