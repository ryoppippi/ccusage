import { $ } from "bun";
import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./src/*.ts", "!./src/**/*.test.ts"],
	outDir: "dist",
	format: "esm",
	clean: true,
	sourcemap: false,
	dts: {
		resolve: ["valibot"],
	},
	publint: true,
	unused: true,
	exports: true,
	hooks: {
		"build:done": async () => {
			await $`bun x sort-package-json`;
		},
	},
});
