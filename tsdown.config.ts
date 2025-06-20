import NodeExternals from 'rollup-plugin-node-externals';
import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.test.ts', // Exclude test files
		'!./src/_*.ts', // Exclude internal files with underscore prefix
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: {
		tsgo: true,
		resolve: ['type-fest'],
	},
	publint: true,
	unused: true,
	exports: true,
	plugins: [
		NodeExternals(),
		Macros({
			include: ['src/index.ts', 'src/pricing-fetcher.ts'],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
