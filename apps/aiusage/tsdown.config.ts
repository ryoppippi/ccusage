import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	platform: 'node',
	target: 'node20.19.4',
	clean: true,
	shims: true,
	splitting: true,
	dts: false,
	treeshake: true,
	outDir: 'dist',
});
