import type { LiteLLMPricingFetcher, PricingLogger } from '@ccusage/internal/pricing';

export const agentIds = ['claude', 'codex', 'opencode', 'amp', 'pi'] as const;
export type AgentId = (typeof agentIds)[number];
export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'session';

export type AdapterOptions = {
	all?: boolean;
	config?: string;
	json?: boolean;
	since?: string;
	until?: string;
	timezone?: string;
	compact?: boolean;
	offline?: boolean;
	speed?: string;
	piPath?: string;
};

export type AgentUsageRow = {
	period: string;
	agent: AgentId | 'all';
	modelsUsed: string[];
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalTokens: number;
	totalCost: number;
	metadata?: Record<string, unknown>;
	agentBreakdowns?: AgentUsageRow[];
};

export type AdapterProgress = {
	pricingLogger?: PricingLogger;
	start: (agent: AgentId) => void;
	succeed: (agent: AgentId, rows: number) => void;
	fail: (agent: AgentId, error: unknown) => void;
	stop: () => void;
};

export type AdapterContext = {
	pricingFetcher?: LiteLLMPricingFetcher;
	progress?: AdapterProgress;
};

export const agentLabels = {
	all: 'All',
	claude: 'Claude',
	codex: 'Codex',
	opencode: 'OpenCode',
	amp: 'Amp',
	pi: 'pi-agent',
} as const satisfies Record<AgentId | 'all', string>;
