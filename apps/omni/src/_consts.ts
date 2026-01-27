import type { Source } from './_types.ts';
import pc from 'picocolors';

export const SOURCE_ORDER: Source[] = ['claude', 'codex', 'opencode', 'pi'];

export const SOURCE_LABELS: Record<Source, string> = {
	claude: 'Claude',
	codex: 'Codex',
	opencode: 'OpenCode',
	pi: 'Pi',
};

export const SOURCE_COLORS: Record<Source, (value: string) => string> = {
	claude: pc.cyan,
	codex: pc.blue,
	opencode: pc.magenta,
	pi: pc.green,
};

export const CODEX_CACHE_MARK = '\u2020';
export const CODEX_CACHE_NOTE = `${CODEX_CACHE_MARK} Codex cache is subset of input (not additive)`;
