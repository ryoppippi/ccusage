import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const urls = (process.env.PKG_PR_NEW_URLS ?? '').split(/\s+/).filter(Boolean);
const previewUrl = urls.find((url) => /(?:^|\/)ccusage@/.test(url));

if (previewUrl == null) {
	throw new Error(`ccusage preview URL not found in: ${urls.join(', ')}`);
}

for (const dir of ['.claude/projects', '.config/claude/projects']) {
	mkdirSync(join(homedir(), dir), { recursive: true });
}

const claudeConfigDir = mkdtempSync(join(tmpdir(), 'ccusage-preview-e2e-'));
const fixtureDir = join(claudeConfigDir, 'projects', 'preview-e2e-project', 'preview-e2e-session');
mkdirSync(fixtureDir, { recursive: true });
const jsonlLines = [];
for (let index = 0; index < 420; index++) {
	const date = new Date(Date.UTC(2026, 0, 1 + index));
	const day = date.toISOString().slice(0, 10);
	jsonlLines.push(
		`{"timestamp":"${day}T10:00:00.000Z","sessionId":"preview-e2e-session","message":{"role":"assistant","id":"preview-e2e-msg-${index}-1","model":"claude-sonnet-4-20250514","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":25,"cache_read_input_tokens":10}},"requestId":"preview-e2e-req-${index}-1","costUSD":0.12,"version":"1.0.0"}`,
		`{"timestamp":"${day}T12:30:00.000Z","sessionId":"preview-e2e-session","message":{"role":"assistant","id":"preview-e2e-msg-${index}-2","model":"claude-opus-4-20250514","usage":{"input_tokens":200,"output_tokens":75,"cache_creation_input_tokens":50,"cache_read_input_tokens":20}},"requestId":"preview-e2e-req-${index}-2","costUSD":0.34,"version":"1.0.0"}`,
	);
}
writeFileSync(join(fixtureDir, 'chat.jsonl'), `${jsonlLines.join('\n')}\n`);

const githubEnv = process.env.GITHUB_ENV;

if (githubEnv == null) {
	throw new Error('GITHUB_ENV is not set');
}

appendFileSync(
	githubEnv,
	[
		`CCUSAGE_PREVIEW_URL=${previewUrl}`,
		`CLAUDE_CONFIG_DIR=${claudeConfigDir}`,
		'LOG_LEVEL=0',
		'',
	].join('\n'),
);
