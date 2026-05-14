import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from 'fs-fixture';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureTemplatePath = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
const snapshotRoot = fileURLToPath(new URL('./snapshots/cli-output/', import.meta.url));

describe('ccusage output snapshots', () => {
	it('matches daily JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'daily', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'daily-json.txt'),
		);
	});

	it('matches session JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'session', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'session-json.txt'),
		);
	});

	it('matches blocks JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'blocks', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'blocks-json.txt'),
		);
	});

	it('matches monthly JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'monthly', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'monthly-json.txt'),
		);
	});

	it('matches weekly JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'weekly', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'weekly-json.txt'),
		);
	});

	it('matches daily table output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'daily', '--offline'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'daily-table.txt'),
		);
	});

	it('matches session table output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'session', '--offline'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'session-table.txt'),
		);
	});

	it('matches blocks table output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'blocks', '--offline'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: {
				CLAUDE_CONFIG_DIR: fixture.path,
				COLUMNS: '200',
				LOG_LEVEL: '3',
				NO_COLOR: '1',
				PATH: process.env.PATH,
				TZ: 'UTC',
			},
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'blocks-table.txt'),
		);
	});
});
