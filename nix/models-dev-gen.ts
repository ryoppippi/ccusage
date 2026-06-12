/**
 * Generate the committed models.dev pricing snapshot.
 *
 * models.dev ships per-model TOML sources rather than a prebuilt catalog, so we
 * reuse its own `generateCatalog` routine (the same code that backs
 * https://models.dev/api.json) and then compact the result down to the
 * Anthropic-relevant models and the few pricing fields ccusage consumes. The
 * embedded output is a flat map keyed by runtime model id. The output is
 * committed to the repository and embedded at build time, so every platform
 * ships the identical, pinned data without any build-time network access. The
 * same pinned catalog also generates the Codex auto-review fallback metadata
 * used by the Rust parser. Run via `just gen-models-dev-pricing` (see
 * `nix/models-dev-pricing.nix`).
 */
import { generateCatalog } from './packages/core/src/generate.ts';
import {
	formatDuplicateModelsDevPricingKeyWarning,
	selectModelsDevPricingKey,
} from './models-dev-compact.ts';

/** Model ids/keys we keep; ccusage is Claude-first, so we embed Anthropic models. */
const KEEP = /claude|anthropic/i;

type Cost = {
	input?: number | null;
	output?: number | null;
	cache_read?: number | null;
	cache_write?: number | null;
};
type Model = { id?: string; cost?: Cost; limit?: { context?: number | null } };
type ModelMetadata = {
	id?: string;
	release_date?: string;
};
type Provider = { models?: Record<string, Model> };
type EmbeddedModel = {
	cost: Cost;
	limit?: { context: number };
};
type CodexAutoReviewFallback = {
	releasedOn: string;
	model: string;
};

const { models, providers } = (await generateCatalog('.')) as {
	models: Record<string, ModelMetadata>;
	providers: Record<string, Provider>;
};

const out: Record<string, EmbeddedModel> = {};
for (const provider of Object.values(providers)) {
	for (const [modelId, model] of Object.entries(provider.models ?? {})) {
		// models.dev also exposes the canonical id under `id`; match either so
		// provider-prefixed aliases (e.g. us.anthropic.*) are kept too.
		if (!(KEEP.test(modelId) || KEEP.test(model.id ?? ''))) {
			continue;
		}
		const cost = model.cost ?? {};
		// Skip entries without the base prices the runtime loader requires.
		if (cost.input == null || cost.output == null) {
			continue;
		}
		const pricingKey = selectModelsDevPricingKey(modelId, model.id);
		if (out[pricingKey] != null) {
			console.warn(
				formatDuplicateModelsDevPricingKeyWarning({
					pricingKey,
					sourceModelId: modelId,
				}),
			);
			continue;
		}
		const entry: EmbeddedModel = {
			cost: {
				input: cost.input,
				output: cost.output,
				...(cost.cache_read != null ? { cache_read: cost.cache_read } : {}),
				...(cost.cache_write != null ? { cache_write: cost.cache_write } : {}),
			},
		};
		if (model.limit?.context != null) {
			entry.limit = { context: model.limit.context };
		}
		out[pricingKey] = entry;
	}
}

// Stable key ordering keeps the committed snapshot's diffs minimal across regenerations.
const sortObject = (value: unknown): unknown => {
	if (Array.isArray(value)) {
		return value.map(sortObject);
	}
	if (value != null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((key) => [key, sortObject((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
};

const outfile = process.env.OUTFILE;
if (outfile == null || outfile.length === 0) {
	throw new Error('OUTFILE environment variable is required');
}

await Bun.write(outfile, `${JSON.stringify(sortObject(out), null, 2)}\n`);

const codexFallbacksOutfile = process.env.CODEX_AUTO_REVIEW_FALLBACKS_OUTFILE;
if (codexFallbacksOutfile != null && codexFallbacksOutfile.length > 0) {
	await Bun.write(
		codexFallbacksOutfile,
		`${JSON.stringify(generateCodexAutoReviewFallbacks(models), null, 2)}\n`,
	);
}

function generateCodexAutoReviewFallbacks(
	models: Record<string, ModelMetadata>,
): CodexAutoReviewFallback[] {
	const entries = Object.entries(models).filter(([modelId, model]) =>
		isCodexAutoReviewFallbackCandidate(modelId, model),
	);
	const codexDecimalVersions = new Set(
		entries
			.map(([modelId]) => codexDecimalVersion(openAiModelName(modelId)))
			.filter((version): version is string => version != null),
	);

	return entries
		.filter(([modelId]) => {
			const version = baseDecimalVersion(openAiModelName(modelId));
			return version == null || !codexDecimalVersions.has(version);
		})
		.map(([modelId, model]) => ({
			releasedOn: model.release_date!,
			model: openAiModelName(model.id ?? modelId),
		}))
		.sort((left, right) => right.releasedOn.localeCompare(left.releasedOn));
}

function isCodexAutoReviewFallbackCandidate(modelId: string, model: ModelMetadata): boolean {
	if (model.release_date == null || !/^\d{4}-\d{2}-\d{2}$/.test(model.release_date)) {
		return false;
	}
	const modelName = openAiModelName(modelId);
	return (
		modelName === 'gpt-5' ||
		modelName === 'gpt-5-codex' ||
		/^gpt-5\.\d+$/.test(modelName) ||
		/^gpt-5\.\d+-codex$/.test(modelName)
	);
}

function baseDecimalVersion(modelId: string): string | undefined {
	return /^gpt-5\.\d+$/.test(modelId) ? modelId : undefined;
}

function codexDecimalVersion(modelId: string): string | undefined {
	const match = /^(gpt-5\.\d+)-codex$/.exec(modelId);
	return match?.[1];
}

function openAiModelName(modelId: string): string {
	return modelId.startsWith('openai/') ? modelId.slice('openai/'.length) : modelId;
}
