import type { PricingLogger } from '@ccusage/internal/pricing';
import type { AdapterProgress, AgentId } from '../adapter/types.ts';
import { Spinner } from 'picospinner';
import { agentLabels } from '../adapter/types.ts';

type LoadProgressState = 'loading' | 'succeeded' | 'failed';

export type UsageLoadProgress = AdapterProgress & {
	pricingLogger: PricingLogger;
};

type TtyLike = {
	isTTY?: boolean;
};

export function shouldShowUsageLoadProgress(options: { json?: boolean }, output: TtyLike): boolean {
	return options.json !== true && output.isTTY === true;
}

function formatProgressLogArgs(args: unknown[]): string {
	return args
		.map((arg) => {
			if (arg instanceof Error) {
				return arg.message;
			}
			return String(arg);
		})
		.join(' ');
}

function formatUsageLoadProgressText(
	states: ReadonlyMap<AgentId, LoadProgressState>,
	status?: string,
): string {
	const base =
		states.size === 0
			? 'Loading usage logs'
			: (() => {
					const completed = Array.from(states.values()).filter(
						(state) => state !== 'loading',
					).length;
					const loadingAgents = Array.from(states.entries())
						.filter(([, state]) => state === 'loading')
						.map(([agent]) => agentLabels[agent])
						.join(', ');
					const suffix = loadingAgents === '' ? '' : ` :: ${loadingAgents}`;
					return `Loading usage logs (${completed}/${states.size})${suffix}`;
				})();
	return status == null ? base : `${status} :: ${base}`;
}

export function createUsageLoadProgress(enabled: boolean): UsageLoadProgress | undefined {
	if (!enabled) {
		return undefined;
	}
	let spinner: Spinner | undefined;
	let status: string | undefined;
	const states = new Map<AgentId, LoadProgressState>();

	function refresh(): void {
		spinner?.setText(formatUsageLoadProgressText(states, status));
	}

	const pricingLogger: PricingLogger = {
		debug: () => {},
		error(...args) {
			status = formatProgressLogArgs(args);
			refresh();
		},
		info(...args) {
			status = formatProgressLogArgs(args);
			refresh();
		},
		warn(...args) {
			status = formatProgressLogArgs(args);
			refresh();
		},
	};

	return {
		pricingLogger,
		start(agent) {
			states.set(agent, 'loading');
			if (spinner == null) {
				spinner = new Spinner(formatUsageLoadProgressText(states, status));
				spinner.start();
				return;
			}
			refresh();
		},
		succeed(agent) {
			states.set(agent, 'succeeded');
			refresh();
		},
		fail(agent) {
			states.set(agent, 'failed');
			refresh();
		},
		stop() {
			if (spinner?.running === true) {
				spinner.stop();
			}
			spinner = undefined;
			status = undefined;
			states.clear();
		},
	};
}

if (import.meta.vitest != null) {
	describe('formatUsageLoadProgressText', () => {
		it('renders one progress message for active agent loads', () => {
			expect(
				formatUsageLoadProgressText(
					new Map<AgentId, LoadProgressState>([
						['claude', 'succeeded'],
						['codex', 'loading'],
						['opencode', 'loading'],
					]),
				),
			).toBe('Loading usage logs (1/3) :: Codex, OpenCode');
		});

		it('includes pricing status in the progress message', () => {
			expect(
				formatUsageLoadProgressText(
					new Map<AgentId, LoadProgressState>([
						['claude', 'loading'],
						['codex', 'loading'],
					]),
					'Fetching latest model pricing from LiteLLM...',
				),
			).toBe(
				'Fetching latest model pricing from LiteLLM... :: Loading usage logs (0/2) :: Claude, Codex',
			);
		});

		it('omits active labels once every load has completed', () => {
			expect(
				formatUsageLoadProgressText(
					new Map<AgentId, LoadProgressState>([
						['claude', 'succeeded'],
						['codex', 'failed'],
					]),
				),
			).toBe('Loading usage logs (2/2)');
		});
	});

	describe('shouldShowUsageLoadProgress', () => {
		it('does not show progress in JSON mode even on a TTY', () => {
			expect(shouldShowUsageLoadProgress({ json: true }, { isTTY: true })).toBe(false);
		});

		it('shows progress only for table output on a TTY', () => {
			expect(shouldShowUsageLoadProgress({ json: false }, { isTTY: true })).toBe(true);
		});

		it('does not show progress when stdout is not a TTY', () => {
			expect(shouldShowUsageLoadProgress({ json: false }, { isTTY: false })).toBe(false);
		});
	});
}
