import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'bumpp';

const RUST_RELEASE_FILE_PATTERN = /^rust\/(?:Cargo\.lock|crates\/[^/]+\/Cargo\.toml)$/;
const GIT_STATUS_FILE_PATTERN = /^.. (?<filePath>.+)$/;

function getUpdatedRustReleaseFiles(cwd: string): string[] {
	const result = spawnSync('git', ['status', '--short', '--', 'rust/Cargo.lock', 'rust/crates'], {
		cwd,
		encoding: 'utf8',
	});
	if (result.error != null) {
		throw result.error;
	}
	if (result.status !== 0) {
		throw new Error(`git status failed with exit code ${result.status ?? 'unknown'}`);
	}
	return result.stdout
		.split('\n')
		.map((line) => GIT_STATUS_FILE_PATTERN.exec(line)?.groups?.filePath)
		.filter(
			(filePath): filePath is string =>
				filePath != null && RUST_RELEASE_FILE_PATTERN.test(filePath),
		);
}

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
					...getUpdatedRustReleaseFiles(operation.options.cwd).map((filePath) =>
						resolve(operation.options.cwd, filePath),
					),
				]),
			],
		});
	},
});
