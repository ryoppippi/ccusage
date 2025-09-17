import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';
import Unused from 'unplugin-unused/rolldown';

export default defineConfig({
	entry: ['src/index.ts'],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: false,
	publint: true,
	unused: true,
	nodeProtocol: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing.ts'],
		}),
		Unused(),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
	onSuccess: 'sort-package-json',
});
