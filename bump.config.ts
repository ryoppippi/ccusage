import { defineConfig } from 'bumpp';

import { rustVersionFilePaths, syncRustVersion } from './apps/ccusage/scripts/sync-rust-version.ts';

export default defineConfig({
	async execute(operation) {
		await syncRustVersion(operation.options.cwd);
		operation.update({
			updatedFiles: [
				...new Set([
					...operation.state.updatedFiles,
					...rustVersionFilePaths(operation.options.cwd),
				]),
			],
		});
	},
});
