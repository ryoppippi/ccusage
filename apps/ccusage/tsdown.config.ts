import { defineConfig } from 'tsdown';
import Macros from 'unplugin-macros/rolldown';

export default defineConfig({
	entry: {
		cli: './src/cli.ts',
		index: './src/index.ts',
		'main.node': './src/main.node.ts',
		'main.bun': './src/main.bun.ts',
		// Dedicated worker entry for the optimized Claude loader chunk introduced in #984.
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
				'src/pricing-fetcher.ts',
				'src/adapter/amp/pricing.ts',
				'src/adapter/codex/pricing.ts',
				'../amp/src/pricing.ts',
				'../codex/src/pricing.ts',
			],
		}),
	],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
