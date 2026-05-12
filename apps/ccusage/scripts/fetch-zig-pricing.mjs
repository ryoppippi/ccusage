import { writeFileSync } from 'node:fs';

const url =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const response = await fetch(url);

if (!response.ok) {
	throw new Error(`Failed to fetch LiteLLM pricing: ${response.status} ${response.statusText}`);
}

const data = await response.json();
const filtered = Object.fromEntries(
	Object.entries(data).filter(
		([modelName]) =>
			modelName.startsWith('claude-') ||
			modelName.startsWith('anthropic/claude-') ||
			modelName.startsWith('anthropic.claude-'),
	),
);

writeFileSync(
	new URL('../src-zig/claude-pricing.json', import.meta.url),
	`${JSON.stringify(filtered)}\n`,
);
console.log(`Wrote ${Object.keys(filtered).length} Claude pricing entries`);
