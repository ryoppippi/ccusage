import { selectModelsDevPricingKey } from './models-dev-compact.ts';

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
