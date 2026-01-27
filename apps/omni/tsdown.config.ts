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
	define: {
		'import.meta.vitest': 'undefined',
	},
});
