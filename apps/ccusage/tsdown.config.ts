import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		index: './src/index.ts',
		'main.node': './src/main.node.ts',
		'main.bun': './src/main.bun.ts',
		'data-loader': './src/data-loader.ts',
	},
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: true,
	minify: true,
	treeshake: {
		moduleSideEffects: false,
	},
	fixedExtension: false,
	dts: false,
	publint: true,
	unused: true,
	deps: {
		onlyBundle: false,
	},
	inputOptions: {
		optimization: {
			inlineConst: {
				mode: 'all',
				pass: 2,
			},
		},
		preserveEntrySignatures: false,
	},
	outputOptions: {
		comments: {
			legal: true,
			annotation: true,
			jsdoc: false,
		},
	},
	nodeProtocol: true,
	plugins: [
		Macros({
			include: [
				'src/index.ts',
				'src/_pricing-fetcher.ts',
				'../amp/src/pricing.ts',
				'../codex/src/pricing.ts',
			],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
