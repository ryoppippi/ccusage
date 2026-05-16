import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixture } from 'fs-fixture';

const appRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureTemplatePath = fileURLToPath(new URL('./fixtures/claude', import.meta.url));
const snapshotRoot = fileURLToPath(new URL('./snapshots/cli-output/', import.meta.url));

type DailyJsonOutput = {
	daily: Array<{
		agent: string;
		period: string;
		inputTokens: number;
		outputTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalTokens: number;
		metadata?: {
			agents?: string[];
		};
	}>;
};

async function createCliEnv(fixturePath: string, tempDir: string): Promise<NodeJS.ProcessEnv> {
	const agentRoot = path.join(tempDir, 'empty-agents');
	const codexHome = path.join(agentRoot, 'codex');
	const opencodeDir = path.join(agentRoot, 'opencode');
	const ampDir = path.join(agentRoot, 'amp');
	const piDir = path.join(agentRoot, 'pi');
	await Promise.all(
		[codexHome, opencodeDir, ampDir, piDir].map(async (dir) => mkdir(dir, { recursive: true })),
	);

	return {
		AMP_DATA_DIR: ampDir,
		CLAUDE_CONFIG_DIR: fixturePath,
		CODEX_HOME: codexHome,
		COLUMNS: '200',
		LOG_LEVEL: '3',
		NO_COLOR: '1',
		OPENCODE_DATA_DIR: opencodeDir,
		PATH: process.env.PATH,
		PI_AGENT_DIR: piDir,
		TZ: 'UTC',
	};
}

function createAgentFixtureTree() {
	return {
		amp: {
			threads: {
				'amp-thread.json': JSON.stringify({
					v: 195,
					id: 'T-e2e-amp',
					created: 1_763_894_400_000,
					title: 'E2E Amp',
					messages: [
						{
							role: 'assistant',
							messageId: 1,
							usage: {
								model: 'claude-haiku-4-5-20251001',
								inputTokens: 100,
								outputTokens: 50,
								cacheCreationInputTokens: 20,
								cacheReadInputTokens: 10,
							},
						},
					],
					usageLedger: {
						events: [
							{
								id: 'amp-event-1',
								timestamp: '2026-01-02T00:00:00.000Z',
								model: 'claude-haiku-4-5-20251001',
								credits: 1.5,
								tokens: { input: 100, output: 50 },
								operationType: 'inference',
								toMessageId: 1,
							},
						],
					},
				}),
			},
		},
		claude: {
			projects: {},
		},
		codex: {
			sessions: {
				'codex-session.jsonl': [
					JSON.stringify({
						timestamp: '2026-01-02T00:00:00.000Z',
						type: 'turn_context',
						payload: { model: 'gpt-5' },
					}),
					JSON.stringify({
						timestamp: '2026-01-02T00:00:01.000Z',
						type: 'event_msg',
						payload: {
							type: 'token_count',
							info: {
								total_token_usage: {
									input_tokens: 100,
									cached_input_tokens: 10,
									output_tokens: 50,
									reasoning_output_tokens: 0,
									total_tokens: 150,
								},
								model: 'gpt-5',
							},
						},
					}),
				].join('\n'),
			},
		},
		opencode: {
			storage: {
				message: {
					'message.json': JSON.stringify({
						id: 'opencode-message',
						sessionID: 'opencode-session',
						providerID: 'anthropic',
						modelID: 'claude-sonnet-4-20250514',
						time: {
							created: 1_767_312_000_000,
						},
						tokens: {
							input: 100,
							output: 50,
							cache: {
								read: 10,
								write: 20,
							},
						},
					}),
				},
				session: {
					'session.json': JSON.stringify({
						id: 'opencode-session',
						title: 'E2E OpenCode',
						projectID: 'project',
						directory: '/tmp/project',
					}),
				},
			},
		},
		pi: {
			sessions: {
				project: {
					'session-id.jsonl': JSON.stringify({
						type: 'message',
						timestamp: '2026-01-02T00:00:00.000Z',
						message: {
							role: 'assistant',
							model: 'claude-opus-4-20250514',
							usage: {
								input: 100,
								output: 50,
								cacheRead: 10,
								cacheWrite: 20,
								totalTokens: 180,
							},
						},
					}),
				},
			},
		},
	};
}

function createAgentCliEnv(fixturePath: string): NodeJS.ProcessEnv {
	return {
		AMP_DATA_DIR: path.join(fixturePath, 'amp'),
		CLAUDE_CONFIG_DIR: path.join(fixturePath, 'claude'),
		CODEX_HOME: path.join(fixturePath, 'codex'),
		COLUMNS: '200',
		LOG_LEVEL: '3',
		NO_COLOR: '1',
		OPENCODE_DATA_DIR: path.join(fixturePath, 'opencode'),
		PATH: process.env.PATH,
		PI_AGENT_DIR: path.join(fixturePath, 'pi', 'sessions'),
		TZ: 'UTC',
	};
}

function runCcusage(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof spawnSync> {
	return spawnSync('bun', ['./src/index.ts', ...args], {
		cwd: appRoot,
		encoding: 'utf8',
		env,
	});
}

function getStdout(result: ReturnType<typeof spawnSync>): string {
	return typeof result.stdout === 'string' ? result.stdout : result.stdout.toString('utf8');
}

describe('ccusage output snapshots', () => {
	it('matches daily JSON output', async () => {
		const tempDir = path.join(tmpdir(), 'ccusage-cli-output-fixtures');
		await mkdir(tempDir, { recursive: true });
		await using fixture = await createFixture(fixtureTemplatePath, { tempDir });

		const result = spawnSync('bun', ['./src/index.ts', 'daily', '--offline', '--json'], {
			cwd: appRoot,
			encoding: 'utf8',
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
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
			env: await createCliEnv(fixture.path, tempDir),
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(result.stdout.replace(/\n$/, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'blocks-table.txt'),
		);
	});
});

describe('ccusage all-agent CLI', () => {
	it('loads all configured agents from the main ccusage command', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(
			['daily', '--offline', '--json', '--since', '20260102', '--until', '20260102'],
			createAgentCliEnv(fixture.path),
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');

		const stdout = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(stdout).toMatchFileSnapshot(path.join(snapshotRoot, 'all-agent-daily-json.txt'));

		const output = JSON.parse(stdout) as DailyJsonOutput;
		expect(output.daily).toHaveLength(1);
		expect(output.daily[0]).toEqual(
			expect.objectContaining({
				agent: 'all',
				cacheCreationTokens: 60,
				cacheReadTokens: 40,
				inputTokens: 400,
				outputTokens: 200,
				period: '2026-01-02',
				totalTokens: 700,
			}),
		);
		expect(output.daily[0]?.metadata?.agents).toEqual(['amp', 'codex', 'opencode', 'pi']);
	});

	it('passes agent namespace config to all-agent loaders', async () => {
		const fixtureTree = createAgentFixtureTree();
		await using fixture = await createFixture({
			...fixtureTree,
			claude: {
				...fixtureTree.claude,
				'ccusage.json': JSON.stringify({
					defaults: {
						json: true,
						offline: true,
					},
					codex: {
						commands: {
							daily: {
								since: '20260103',
								until: '20260103',
							},
						},
					},
				}),
			},
		});

		const result = runCcusage(['daily'], createAgentCliEnv(fixture.path));

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const output = JSON.parse(getStdout(result)) as DailyJsonOutput;
		expect(output.daily).toHaveLength(1);
		expect(output.daily[0]).toEqual(
			expect.objectContaining({
				agent: 'all',
				cacheCreationTokens: 60,
				cacheReadTokens: 30,
				inputTokens: 300,
				outputTokens: 150,
				period: '2026-01-02',
				totalTokens: 540,
			}),
		);
		expect(output.daily[0]?.metadata?.agents).toEqual(['amp', 'opencode', 'pi']);
	});

	it('runs agent namespaces through the main ccusage command', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(
			['codex', 'daily', '--offline', '--json', '--since', '20260102', '--until', '20260102'],
			createAgentCliEnv(fixture.path),
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const stdout = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(stdout).toMatchFileSnapshot(
			path.join(snapshotRoot, 'codex-direct-daily-json.txt'),
		);

		const output = JSON.parse(stdout) as {
			daily: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
		};
		expect(output.daily).toEqual([
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
			}),
		]);
	});

	it('loads agent namespace config for direct agent commands', async () => {
		const fixtureTree = createAgentFixtureTree();
		await using fixture = await createFixture({
			...fixtureTree,
			claude: {
				...fixtureTree.claude,
				'ccusage.json': JSON.stringify({
					codex: {
						defaults: {
							json: true,
							offline: true,
						},
						commands: {
							daily: {
								since: '20260102',
								until: '20260102',
							},
						},
					},
				}),
			},
		});

		const result = runCcusage(['codex', 'daily'], createAgentCliEnv(fixture.path));

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const output = JSON.parse(getStdout(result)) as {
			daily: Array<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
		};
		expect(output.daily).toEqual([
			expect.objectContaining({
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
			}),
		]);
	});

	it('passes offline mode through agent namespaces', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(['opencode', '--offline', '--json'], createAgentCliEnv(fixture.path));

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(getStdout(result).replace(/\n$/u, '')).toMatchFileSnapshot(
			path.join(snapshotRoot, 'opencode-direct-daily-json.txt'),
		);
	});

	it('includes cache tokens in Amp direct total tokens', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(['amp', '--offline', '--json'], createAgentCliEnv(fixture.path));

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');

		const stdout = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(stdout).toMatchFileSnapshot(path.join(snapshotRoot, 'amp-direct-daily-json.txt'));

		const output = JSON.parse(stdout) as {
			daily: Array<{ totalTokens: number }>;
			totals: { totalTokens: number };
		};
		expect(output.daily[0]?.totalTokens).toBe(180);
		expect(output.totals.totalTokens).toBe(180);
	});

	it('keeps full Amp direct tables when all columns fit', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(['amp', '--offline'], {
			...createAgentCliEnv(fixture.path),
			COLUMNS: '150',
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const output = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(output).toMatchFileSnapshot(path.join(snapshotRoot, 'amp-direct-full-table.txt'));
		expect(output).not.toContain('Running in Compact Mode');
		expect(output).toContain('Cache Create');
		expect(output).toContain('Cache Read');
		expect(output).toContain('Total Tokens');
	});

	it('uses compact Amp direct tables when full columns do not fit', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(['amp', '--offline'], {
			...createAgentCliEnv(fixture.path),
			COLUMNS: '100',
		});

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const output = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(output).toMatchFileSnapshot(
			path.join(snapshotRoot, 'amp-direct-compact-table.txt'),
		);
		expect(output).toContain('Running in Compact Mode');
		expect(output).toContain('Credits');
		expect(output).not.toContain('Cache Create');
		expect(output).not.toContain('Total Tokens');
	});

	it('renders same-day all-agent table rows as one grouped period', async () => {
		await using fixture = await createFixture(createAgentFixtureTree());

		const result = runCcusage(
			['daily', '--offline', '--since', '20260102', '--until', '20260102'],
			{
				...createAgentCliEnv(fixture.path),
				COLUMNS: '120',
			},
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		const output = getStdout(result).replace(/\n$/u, '');
		await mkdir(snapshotRoot, { recursive: true });
		await expect(output).toMatchFileSnapshot(path.join(snapshotRoot, 'all-agent-daily-table.txt'));
		expect(output).toContain('Coding Agent Usage Report - Daily');
		expect(output).toContain('Detected: Amp, Codex, OpenCode, pi-agent');
		expect(output.match(/2026-01-02/gu)).toHaveLength(1);
		expect(output).toContain('Amp');
		expect(output).toContain('Codex');
		expect(output).toContain('OpenCode');
		expect(output).toContain('pi-agent');
		expect(output).toContain('$');
	});

	it('keeps agent selection on subcommands instead of --agent filters', () => {
		const result = runCcusage(
			['daily', '--agent', 'codex'],
			createAgentCliEnv('/tmp/unused-ccusage-agents'),
		);

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('Agent filters like --agent are not supported.');
		expect(result.stderr).toContain('ccusage codex daily');
	});

	it('rejects unsupported agent report combinations in ccusage', () => {
		const result = runCcusage(['codex', 'blocks'], createAgentCliEnv('/tmp/unused-ccusage-agents'));

		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('The "blocks" report is only available for Claude Code usage.');
	});
});
