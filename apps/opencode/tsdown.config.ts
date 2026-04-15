import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	clean: true,
	dts: false,
	shims: true,
	platform: 'node',
	target: 'node20',
	fixedExtension: false,
	alias: {
		'bun:sqlite': new URL('./src/_sqlite-node.ts', import.meta.url).pathname,
	},
});
