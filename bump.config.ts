import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'bumpp';

const RUST_VERSION_FILES = [
	'rust/crates/ccusage/Cargo.toml',
	'rust/crates/ccusage-terminal/Cargo.toml',
	'rust/Cargo.lock',
];

export default defineConfig({
	async execute(operation) {
		const result = spawnSync('pnpm', ['run', 'sync:rust-version'], {
			cwd: operation.options.cwd,
			stdio: 'inherit',
		});
		if (result.error != null) {
			throw result.error;
		}
		if (result.status !== 0) {
			throw new Error(`sync:rust-version failed with exit code ${result.status ?? 'unknown'}`);
		}
		operation.update({
			updatedFiles: [
				...new Set([
					...operation.state.updatedFiles,
					...RUST_VERSION_FILES.map((filePath) => resolve(operation.options.cwd, filePath)),
				]),
			],
		});
	},
});
