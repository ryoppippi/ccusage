import Macros from 'unplugin-macros/vite';
import Unused from 'unplugin-unused/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		watch: false,
		includeSource: ['src/**/*.{js,ts}'],
		globals: true,
	},
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing.ts'],
		}) as any,
		Unused(),
	],
});
