import { defineConfig } from 'oxfmt';

export default defineConfig({
	useTabs: true,
	singleQuote: true,
	ignorePatterns: [
		'dist',
		'node_modules',
		'coverage',
		'.git',
		'**/pnpm-lock.yaml',
		'rust/crates/ccusage/src/litellm-pricing-fallback.json',
	],
});
