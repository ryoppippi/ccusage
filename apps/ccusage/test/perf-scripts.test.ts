import {
	createCcusageCommandFromBin,
	renderFixtureSection,
} from '../scripts/compare-pr-performance.ts';
import {
	assertSafeDeletionTarget,
	createCodexUsageLine,
} from '../scripts/generate-large-fixture.ts';

describe('performance scripts', () => {
	it('builds hyperfine command text that always benchmarks the published ccusage bin with both Claude and Codex fixture environment variables', () => {
		const commandText = createCcusageCommandFromBin(
			'/repo/apps/ccusage/dist/cli.js',
			'/fixtures/claude',
			'/fixtures/codex',
			'codex session',
		);

		expect(commandText).toContain('CLAUDE_CONFIG_DIR=/fixtures/claude');
		expect(commandText).toContain('CODEX_HOME=/fixtures/codex');
		expect(commandText).toContain('codex session --offline --json');
	});

	it('creates synthetic Codex token_count JSONL rows that stay on the same fast parser path as real Codex session logs', () => {
		const line = createCodexUsageLine(42, 7);

		expect(line).toContain('"type":"event_msg"');
		expect(line).toContain('"type":"token_count"');
		expect(line).toContain('"last_token_usage"');
		expect(line).toContain('"total_token_usage"');
		expect(line).toContain('"model":"gpt-5.2-codex"');
	});

	it('refuses unsafe fixture deletion targets before the generator shells out to rm -rf', () => {
		expect(() => assertSafeDeletionTarget('/', '--output-dir')).toThrow(
			'Refusing to delete unsafe --output-dir path',
		);
		expect(() => assertSafeDeletionTarget(process.cwd(), '--output-dir')).toThrow(
			'Refusing to delete unsafe --output-dir path',
		);
	});

	it('renders fixture sizes and throughput so Claude and Codex timings are comparable', () => {
		const lines = renderFixtureSection(
			{
				codexFixtureDir: '/fixtures/codex',
				codexFixtureStats: {
					bytes: 512 * 1024 * 1024,
					files: 200,
				},
				description: 'Fixture description',
				fixtureDir: '/fixtures/claude',
				fixtureStats: {
					bytes: 1024 * 1024 * 1024,
					files: 400,
				},
				results: [
					{
						base: { max: 2000, median: 2000, min: 2000, samples: 1 },
						command: 'claude',
						head: { max: 1000, median: 1000, min: 1000, samples: 1 },
					},
					{
						base: { max: 1000, median: 1000, min: 1000, samples: 1 },
						command: 'codex',
						head: { max: 500, median: 500, min: 500, samples: 1 },
					},
				],
				runs: 1,
				title: 'Large fixture',
				warmup: 0,
			},
			{ headDir: '/repo' },
		);

		expect(lines.join('\n')).toContain('Claude `/fixtures/claude` (1.00 GiB, 400 files)');
		expect(lines.join('\n')).toContain('Codex `/fixtures/codex` (512.00 MiB, 200 files)');
		expect(lines.join('\n')).toContain('| `claude --offline --json` | 1.00 GiB |');
		expect(lines.join('\n')).toContain('| `codex --offline --json` | 512.00 MiB |');
		expect(lines.join('\n')).toContain('512.00 MiB/s');
		expect(lines.join('\n')).toContain('1.00 GiB/s');
	});
});
