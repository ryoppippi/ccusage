import { appendFileSync } from 'node:fs';
import process from 'node:process';

const url = process.env.BASE_PACKAGE_URL;

if (url == null || url.length === 0) {
	throw new Error('BASE_PACKAGE_URL is required');
}

let ready = false;
try {
	const response = await fetch(url, { method: 'HEAD' });
	ready = response.ok;
	if (!ready) {
		console.error(`Base preview package is not ready: ${url} (${response.status})`);
	}
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`Base preview package probe failed: ${url}: ${message}`);
}

const githubOutput = process.env.GITHUB_OUTPUT;

if (githubOutput == null) {
	throw new Error('GITHUB_OUTPUT is not set');
}

appendFileSync(githubOutput, `ready=${ready ? 'true' : 'false'}\n`);
appendFileSync(githubOutput, `url=${url}\n`);
