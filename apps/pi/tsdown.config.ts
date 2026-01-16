import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/data-loader.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	fixedExtension: false,
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
});
