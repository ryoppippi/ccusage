import consola from 'consola';
import { dtsroll } from 'dtsroll';
import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'./src/*.ts',
		'!./src/**/*.{test,internal}.ts',
	],
	outDir: 'dist',
	format: 'esm',
	clean: true,
	sourcemap: false,
	dts: {
		resolve: ['valibot'],
	},
	publint: true,
	unused: true,
	exports: true,
	hooks: {
		'build:done': async (ctx) => {
			// console.log(ctx.options.entry);
			const dtsFiles = Object.values(ctx.options.entry).map((file) => {
				/** replace .ts with .d.ts and src to dist */
				return file.replace(/\.ts$/, '.d.ts').replace('src', 'dist');
			});
			const output = await dtsroll({
				inputs: dtsFiles,
			});
			if ('error' in output) {
				throw new Error(`Dtsroll error: ${output.error}`);
			}
			consola.info(output.size);
		},
	},
});
