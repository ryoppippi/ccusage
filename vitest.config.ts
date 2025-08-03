import Macros from 'unplugin-macros/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/**/*.{js,ts}'],
		globals: true,
	},
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
	],
});
