import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/data-loader.ts',
		'src/daily-report.ts',
		'src/monthly-report.ts',
		'src/session-report.ts',
		'src/pricing.ts',
		'src/_types.ts',
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	minify: 'dce-only',
	treeshake: true,
	dts: false,
	publint: true,
	unused: true,
	fixedExtension: false,
	nodeProtocol: true,
	plugins: [
		Macros({
			include: ['src/index.ts', 'src/pricing.ts'],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
