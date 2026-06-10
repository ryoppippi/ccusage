import process from 'node:process';
import { defineConfig } from 'vitest/config';

const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';

export default defineConfig({
	test: {
		passWithNoTests: true,
		watch: false,
		reporters: isGitHubActions ? ['default', 'github-actions'] : ['default'],
		projects: [
			'apps/*/vitest.config.ts',
			'packages/*/vitest.config.ts',
			{
				test: {
					name: 'nix',
					include: ['nix/**/*.test.ts'],
					globals: true,
				},
			},
			{
				test: {
					name: 'github-scripts',
					include: [],
					includeSource: ['.github/scripts/upsert-pr-comment.ts'],
					exclude: ['**/node_modules/**', '**/.git/**', '.direnv/**'],
					globals: true,
				},
			},
		],
	},
});
