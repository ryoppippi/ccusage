/**
 * Generate the committed models.dev pricing snapshot.
 *
 * models.dev ships per-model TOML sources rather than a prebuilt catalog, so we
 * reuse its own `generateCatalog` routine (the same code that backs
 * https://models.dev/api.json) and then compact the result down to the
 * Anthropic-relevant models and the few pricing fields ccusage consumes. The
 * embedded output is a flat map keyed by runtime model id. The output is
 * committed to the repository and embedded at build time, so every platform
 * ships the identical, pinned data without any build-time network access. Run
 * via `just gen-models-dev-pricing` (see `nix/models-dev-pricing.nix`).
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
type Provider = { models?: Record<string, Model> };
type EmbeddedModel = {
	cost: Cost;
	limit?: { context: number };
};

const { providers } = (await generateCatalog('.')) as {
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
