import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['./src/*.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	exports: {
		devExports: true,
	},
	dts: {
		tsgo: true,
	},
	publint: true,
	unused: true,
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
	onSuccess: 'sort-package-json',
});
