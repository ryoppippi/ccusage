import process from 'node:process';
import { sort } from 'fast-sort';

export type UsageGroup = {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	reasoningOutputTokens: number;
};

export function splitUsageTokens(usage: UsageGroup): {
	inputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	outputTokens: number;
} {
	const cacheReadTokens = Math.min(usage.cachedInputTokens, usage.inputTokens);
	const inputTokens = Math.max(usage.inputTokens - cacheReadTokens, 0);
	const outputTokens = Math.max(usage.outputTokens, 0);
	const rawReasoning = usage.reasoningOutputTokens ?? 0;
	const reasoningTokens = Math.max(0, Math.min(rawReasoning, outputTokens));

	return {
		inputTokens,
		reasoningTokens,
		cacheReadTokens,
		outputTokens,
	};
}

export function formatModelsList(
	models: Record<string, { totalTokens: number; isFallback?: boolean }>,
): string[] {
	return sort(Object.entries(models))
		.asc(([model]) => model)
		.map(([model, data]) => (data.isFallback === true ? `${model} (fallback)` : model));
}

const ESCAPE_CODE = 0x1B;
const CSI_FINAL_MIN = 0x40;
const CSI_FINAL_MAX = 0x7E;

export type ColorOptions = {
	color?: boolean;
	noColor?: boolean;
};

export function shouldStripAnsi(options: ColorOptions): boolean {
	if (options.noColor === true) {
		return true;
	}
	if (options.color === true || process.env.FORCE_COLOR != null) {
		return false;
	}

	return process.env.NO_COLOR != null;
}

function stripAnsiSequences(output: string): string {
	let stripped = '';
	for (let index = 0; index < output.length; index++) {
		if (output.charCodeAt(index) !== ESCAPE_CODE || output[index + 1] !== '[') {
			stripped += output[index];
			continue;
		}

		index += 2;
		while (index < output.length) {
			const code = output.charCodeAt(index);
			if (code >= CSI_FINAL_MIN && code <= CSI_FINAL_MAX) {
				break;
			}
			index++;
		}
	}

	return stripped;
}

export function formatTerminalOutput(output: string, options: ColorOptions): string {
	return shouldStripAnsi(options) ? stripAnsiSequences(output) : output;
}

if (import.meta.vitest != null) {
	describe('formatTerminalOutput', () => {
		it('strips ANSI escape codes when no-color is requested', () => {
			expect(formatTerminalOutput('\u001B[36mKimi\u001B[39m', { noColor: true })).toBe('Kimi');
		});

		it('keeps ANSI escape codes when color is forced', () => {
			expect(formatTerminalOutput('\u001B[36mKimi\u001B[39m', { color: true })).toBe(
				'\u001B[36mKimi\u001B[39m',
			);
		});
	});
}
