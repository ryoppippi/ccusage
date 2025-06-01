import { $ } from "bun";
import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["./index.ts", "./data-loader.ts", "./calculate-cost.ts"],
	outDir: "dist",
	format: "esm",
	clean: true,
	sourcemap: false,
	dts: true,
	publint: true,
	unused: true,
	exports: true,
	hooks: {
		"build:done": async () => {
			await $`bun x sort-package-json`;
		},
	},
});
