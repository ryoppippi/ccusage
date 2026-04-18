import * as fs from 'node:fs';
import process from 'node:process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliInvocation } from './cli-utils.ts';

const fixtureEntryPath = '/tmp/example/packages/mcp/src/index.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createCliInvocation', () => {
	it('prefers the current bun executable when already running under bun', () => {
		vi.spyOn(process, 'execPath', 'get').mockReturnValue('/opt/tools/bun');
		vi.spyOn(fs, 'existsSync').mockReturnValue(false);

		expect(createCliInvocation(fixtureEntryPath)).toEqual({
			executable: '/opt/tools/bun',
			prefixArgs: [fixtureEntryPath],
		});
	});

	it('falls back to a workspace-local bun shim for TypeScript entrypoints', () => {
		vi.spyOn(process, 'execPath', 'get').mockReturnValue('/usr/bin/node');
		vi.spyOn(fs, 'existsSync').mockImplementation(
			(candidate) => candidate === '/tmp/example/packages/node_modules/.bin/bun',
		);

		expect(createCliInvocation(fixtureEntryPath)).toEqual({
			executable: '/tmp/example/packages/node_modules/.bin/bun',
			prefixArgs: [fixtureEntryPath],
		});
	});
});
