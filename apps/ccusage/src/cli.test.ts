import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import {
	ensureNativeBinaryExecutable,
	isMainModule,
	resolveCliRuntime,
	resolveNativeBinary,
} from './cli.js';

void describe(resolveCliRuntime.name, () => {
	void it('resolves the native package binary for the current supported platform', () => {
		const actual = resolveNativeBinary({
			arch: 'arm64',
			platform: 'darwin',
			resolvePath: (id) => {
				assert.equal(id, '@ccusage/ccusage-darwin-arm64/bin/ccusage');
				return '/native/bin/ccusage';
			},
		});

		assert.equal(actual, '/native/bin/ccusage');
	});

	void it('resolves the Windows native package binary with the exe suffix', () => {
		const actual = resolveNativeBinary({
			arch: 'arm64',
			platform: 'win32',
			resolvePath: (id) => {
				assert.equal(id, '@ccusage/ccusage-win32-arm64/bin/ccusage.exe');
				return 'C:\\native\\bin\\ccusage.exe';
			},
		});

		assert.equal(actual, 'C:\\native\\bin\\ccusage.exe');
	});

	void it('prefers the matching native package binary when it is available', () => {
		assert.deepEqual(
			resolveCliRuntime({
				argv: ['daily'],
				nativeBinaryPath: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
			}),
			{
				args: ['daily'],
				command: '/app/node_modules/@ccusage/ccusage-darwin-arm64/bin/ccusage',
			},
		);
	});

	void it('fails when the native package binary is unavailable', () => {
		assert.deepEqual(
			resolveCliRuntime({
				arch: 'arm64',
				argv: ['daily'],
				nativeBinaryPath: null,
				platform: 'darwin',
			}),
			{
				errorMessage:
					'ccusage native binary is not available for darwin-arm64. Reinstall ccusage so optional native dependencies are installed.\n',
			},
		);
	});

	void it('repairs a native binary that was extracted without executable bits', () => {
		const chmodPath = mock.fn();

		assert.equal(
			ensureNativeBinaryExecutable({
				binaryPath: '/native/bin/ccusage',
				chmodPath,
				platform: 'linux',
				statPath: () => ({ mode: 0o644 }),
			}),
			undefined,
		);
		assert.deepEqual(
			chmodPath.mock.calls.map((call) => call.arguments),
			[['/native/bin/ccusage', 0o755]],
		);
	});

	void it('does not chmod an already executable native binary', () => {
		const chmodPath = mock.fn();

		assert.equal(
			ensureNativeBinaryExecutable({
				binaryPath: '/native/bin/ccusage',
				chmodPath,
				platform: 'darwin',
				statPath: () => ({ mode: 0o755 }),
			}),
			undefined,
		);
		assert.equal(chmodPath.mock.callCount(), 0);
	});

	void it('does not chmod Windows native binaries', () => {
		const chmodPath = mock.fn();

		assert.equal(
			ensureNativeBinaryExecutable({
				binaryPath: 'C:\\native\\bin\\ccusage.exe',
				chmodPath,
				platform: 'win32',
				statPath: () => ({ mode: 0o644 }),
			}),
			undefined,
		);
		assert.equal(chmodPath.mock.callCount(), 0);
	});

	void it('treats package bin symlinks as the main module entry point', () => {
		const actual = isMainModule({
			argvEntry: '/project/node_modules/.bin/ccusage',
			moduleUrl: 'file:///project/node_modules/ccusage/src/cli.js',
			realpathPath: (path) =>
				path === '/project/node_modules/.bin/ccusage'
					? '/project/node_modules/ccusage/src/cli.js'
					: path,
		});

		assert.equal(actual, true);
	});
});
