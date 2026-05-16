import { createCcusageCommandFromBin } from '../scripts/compare-pr-performance.ts';
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
});
