// Generate the preview-E2E Claude data fixture into the directory passed as the
// first argument. Written once in the publish job (which has a checkout) and
// uploaded as an artifact, so the E2E jobs can run against it WITHOUT checking
// out the repo — keeping their working directory empty so package runners
// (pnpm in particular) behave like a real end user instead of inheriting the
// repo's pnpm-workspace.yaml / package.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const outDir = process.argv[2];

if (outDir == null || outDir === '') {
	throw new Error('usage: generate-e2e-fixture.mjs <out-dir>');
}

// CLAUDE_CONFIG_DIR points at <outDir>; ccusage reads <outDir>/projects/**.
const fixtureDir = join(outDir, 'projects', 'preview-e2e-project', 'preview-e2e-session');
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
