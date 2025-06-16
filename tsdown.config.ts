import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.{test,internal}.ts',
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	external: [
		// fastMCP
		'sury',
		'effect',
	],
	dts: {
		resolve: ['valibot', 'type-fest'],
	},
	publint: true,
	unused: true,
	exports: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
	],
});
