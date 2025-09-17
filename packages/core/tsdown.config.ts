import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/*.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: true,
	unbundle: true,
	minify: false,
	treeshake: true,
	dts: {
		tsgo: true,
	},
	publint: true,
	unused: true,
	exports: {
		devExports: true,
	},
	nodeProtocol: true,
	define: {
		'import.meta.vitest': 'undefined',
	},
	onSuccess: 'sort-package-json',
});
