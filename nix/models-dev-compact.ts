export function selectModelsDevPricingKey(modelId: string, catalogId: string | undefined): string {
	return catalogId != null && catalogId.length > 0 ? catalogId : modelId;
}
