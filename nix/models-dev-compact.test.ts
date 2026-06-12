import {
	formatDuplicateModelsDevPricingKeyWarning,
	shouldReplaceModelsDevPricingCandidate,
	selectModelsDevPricingKey,
} from './models-dev-compact.ts';

it('falls back to the source model id when the catalog id is empty', () => {
	expect(selectModelsDevPricingKey('anthropic/claude-sonnet-4', '')).toBe(
		'anthropic/claude-sonnet-4',
	);
});

it('falls back to the source model id when the catalog id is undefined', () => {
	expect(selectModelsDevPricingKey('anthropic/claude-sonnet-4', undefined)).toBe(
		'anthropic/claude-sonnet-4',
	);
});

it('uses the catalog id when it is non-empty', () => {
	expect(selectModelsDevPricingKey('anthropic/claude-sonnet-4', 'catalog-id-123')).toBe(
		'catalog-id-123',
	);
});

it('formats duplicate pricing key warnings with the skipped source id', () => {
	expect(
		formatDuplicateModelsDevPricingKeyWarning({
			pricingKey: 'claude-sonnet-4',
			sourceModelId: 'anthropic/claude-sonnet-4',
		}),
	).toBe(
		'models.dev pricing key "claude-sonnet-4" already exists; skipping duplicate source model "anthropic/claude-sonnet-4".',
	);
});

it('prefers Anthropic provider pricing over duplicate aliases', () => {
	expect(
		shouldReplaceModelsDevPricingCandidate(
			{
				sourceProviderId: 'github-copilot',
				sourceModelId: 'claude-sonnet-4-6',
				hasContextLimit: true,
				hasExplicitCacheRead: true,
				hasExplicitCacheWrite: true,
			},
			{
				sourceProviderId: 'anthropic',
				sourceModelId: 'claude-sonnet-4-6',
				hasContextLimit: true,
				hasExplicitCacheRead: true,
				hasExplicitCacheWrite: true,
			},
		),
	).toBe(true);
});

it('uses a stable source ordering tie-break for duplicate aliases', () => {
	expect(
		shouldReplaceModelsDevPricingCandidate(
			{
				sourceProviderId: 'nano-gpt',
				sourceModelId: 'claude-sonnet-4',
				hasContextLimit: true,
				hasExplicitCacheRead: true,
				hasExplicitCacheWrite: true,
			},
			{
				sourceProviderId: 'github-copilot',
				sourceModelId: 'claude-sonnet-4',
				hasContextLimit: true,
				hasExplicitCacheRead: true,
				hasExplicitCacheWrite: true,
			},
		),
	).toBe(true);
});
