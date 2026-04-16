import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	clean: true,
	dts: false,
	shims: true,
	platform: 'node',
	target: 'node20',
	fixedExtension: false,
	nodeProtocol: true,
	external: ['bun:sqlite'],
	define: {
		'import.meta.vitest': 'undefined',
	},
});
