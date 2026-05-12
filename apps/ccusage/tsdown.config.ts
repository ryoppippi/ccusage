import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: ['./src/index.ts', './src/data-loader.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: false,
	treeshake: {
		moduleSideEffects: false,
	},
	fixedExtension: false,
	dts: false,
	publint: true,
	unused: true,
	nodeProtocol: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/_pricing-fetcher.ts'],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
