import { selectModelsDevPricingKey } from './models-dev-compact.ts';

it('falls back to the source model id when the catalog id is empty', () => {
	expect(selectModelsDevPricingKey('anthropic/claude-sonnet-4', '')).toBe(
		'anthropic/claude-sonnet-4',
	);
});
