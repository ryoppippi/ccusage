import path from 'node:path';
import process from 'node:process';
import { createFixture } from 'fs-fixture';
import * as cliUtils from './cli-utils.ts';

const fixtureEntryPath = '/tmp/example/packages/mcp/src/index.ts';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('createCliInvocation', () => {
	it('prefers the current bun executable when already running under bun', () => {
		vi.spyOn(process, 'execPath', 'get').mockReturnValue('/opt/tools/bun');
		vi.spyOn(cliUtils, 'pathExists').mockReturnValue(false);

		expect(cliUtils.createCliInvocation(fixtureEntryPath)).toEqual({
			executable: '/opt/tools/bun',
			prefixArgs: [fixtureEntryPath],
		});
	});

	it('falls back to a workspace-local bun shim for TypeScript entrypoints', async () => {
		await using fixture = await createFixture({
			'packages/mcp/src/index.ts': '',
			'packages/node_modules/.bin/bun': '',
		});
		const entryPath = path.join(fixture.path, 'packages', 'mcp', 'src', 'index.ts');

		vi.spyOn(process, 'execPath', 'get').mockReturnValue('/usr/bin/node');

		expect(cliUtils.createCliInvocation(entryPath)).toEqual({
			executable: path.join(fixture.path, 'packages', 'node_modules', '.bin', 'bun'),
			prefixArgs: [entryPath],
		});
	});
});
