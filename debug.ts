import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { glob } from "tinyglobby";
import * as v from "valibot";
import { UsageDataSchema } from "./data-loader.ts";
import { logger } from "./logger.ts";
import {
	calculateCostFromTokens,
	fetchModelPricing,
	getModelPricing,
} from "./pricing-fetcher.ts";

const MATCH_THRESHOLD_PERCENT = 0.1;
interface Discrepancy {
	file: string;
	timestamp: string;
	model: string;
	originalCost: number;
	calculatedCost: number;
	difference: number;
	percentDiff: number;
	usage: {
		input_tokens: number;
		output_tokens: number;
		cache_creation_input_tokens?: number;
		cache_read_input_tokens?: number;
	};
}

interface MismatchStats {
	totalEntries: number;
	entriesWithBoth: number;
	matches: number;
	mismatches: number;
	discrepancies: Discrepancy[];
	modelStats: Map<
		string,
		{
			total: number;
			matches: number;
			mismatches: number;
			avgPercentDiff: number;
		}
	>;
	versionStats: Map<
		string,
		{
			total: number;
			matches: number;
			mismatches: number;
			avgPercentDiff: number;
		}
	>;
}

export async function detectMismatches(
	claudePath?: string,
): Promise<MismatchStats> {
	const claudeDir = claudePath || path.join(homedir(), ".claude", "projects");
	const files = await glob(["**/*.jsonl"], {
		cwd: claudeDir,
		absolute: true,
	});

	// Fetch pricing data
	const modelPricing = await fetchModelPricing();

	const stats: MismatchStats = {
		totalEntries: 0,
		entriesWithBoth: 0,
		matches: 0,
		mismatches: 0,
		discrepancies: [],
		modelStats: new Map(),
		versionStats: new Map(),
	};

	for (const file of files) {
		const content = await readFile(file, "utf-8");
		const lines = content
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line);
				const result = v.safeParse(UsageDataSchema, parsed);

				if (!result.success) continue;

				const data = result.output;
				stats.totalEntries++;

				// Check if we have both costUSD and model
				if (
					data.costUSD !== undefined &&
					data.message.model &&
					data.message.model !== "<synthetic>"
				) {
					stats.entriesWithBoth++;

					const model = data.message.model;
					const pricing = getModelPricing(model, modelPricing);

					if (pricing) {
						const calculatedCost = calculateCostFromTokens(
							data.message.usage,
							pricing,
						);
						const difference = Math.abs(data.costUSD - calculatedCost);
						const percentDiff =
							data.costUSD > 0 ? (difference / data.costUSD) * 100 : 0;

						// Update model statistics
						const modelStat = stats.modelStats.get(model) || {
							total: 0,
							matches: 0,
							mismatches: 0,
							avgPercentDiff: 0,
						};
						modelStat.total++;

						// Update version statistics if version is available
						if (data.version) {
							const versionStat = stats.versionStats.get(data.version) || {
								total: 0,
								matches: 0,
								mismatches: 0,
								avgPercentDiff: 0,
							};
							versionStat.total++;

							// Consider it a match if within the defined threshold (to account for floating point)
							if (percentDiff < MATCH_THRESHOLD_PERCENT) {
								versionStat.matches++;
							} else {
								versionStat.mismatches++;
							}

							// Update average percent difference for version
							versionStat.avgPercentDiff =
								(versionStat.avgPercentDiff * (versionStat.total - 1) +
									percentDiff) /
								versionStat.total;
							stats.versionStats.set(data.version, versionStat);
						}

						// Consider it a match if within 0.1% difference (to account for floating point)
						if (percentDiff < 0.1) {
							stats.matches++;
							modelStat.matches++;
						} else {
							stats.mismatches++;
							modelStat.mismatches++;
							stats.discrepancies.push({
								file: path.basename(file),
								timestamp: data.timestamp,
								model,
								originalCost: data.costUSD,
								calculatedCost,
								difference,
								percentDiff,
								usage: data.message.usage,
							});
						}

						// Update average percent difference
						modelStat.avgPercentDiff =
							(modelStat.avgPercentDiff * (modelStat.total - 1) + percentDiff) /
							modelStat.total;
						stats.modelStats.set(model, modelStat);
					}
				}
			} catch (e) {
				// Skip invalid JSON
			}
		}
	}

	return stats;
}

export function printMismatchReport(
	stats: MismatchStats,
	sampleCount = 5,
): void {
	if (stats.entriesWithBoth === 0) {
		logger.info("No pricing data found to analyze.");
		return;
	}

	const matchRate = (stats.matches / stats.entriesWithBoth) * 100;

	logger.info("\n=== Pricing Mismatch Debug Report ===");
	logger.info(
		`Total entries processed: ${stats.totalEntries.toLocaleString()}`,
	);
	logger.info(
		`Entries with both costUSD and model: ${stats.entriesWithBoth.toLocaleString()}`,
	);
	logger.info(`Matches (within 0.1%): ${stats.matches.toLocaleString()}`);
	logger.info(`Mismatches: ${stats.mismatches.toLocaleString()}`);
	logger.info(`Match rate: ${matchRate.toFixed(2)}%`);

	// Show model-by-model breakdown if there are mismatches
	if (stats.mismatches > 0 && stats.modelStats.size > 0) {
		logger.info("\n=== Model Statistics ===");
		const sortedModels = Array.from(stats.modelStats.entries()).sort(
			(a, b) => b[1].mismatches - a[1].mismatches,
		);

		for (const [model, modelStat] of sortedModels) {
			if (modelStat.mismatches > 0) {
				const modelMatchRate = (modelStat.matches / modelStat.total) * 100;
				logger.info(`${model}:`);
				logger.info(`  Total entries: ${modelStat.total.toLocaleString()}`);
				logger.info(
					`  Matches: ${modelStat.matches.toLocaleString()} (${modelMatchRate.toFixed(1)}%)`,
				);
				logger.info(`  Mismatches: ${modelStat.mismatches.toLocaleString()}`);
				logger.info(
					`  Avg % difference: ${modelStat.avgPercentDiff.toFixed(1)}%`,
				);
			}
		}
	}

	// Show version statistics if there are mismatches
	if (stats.mismatches > 0 && stats.versionStats.size > 0) {
		logger.info("\n=== Version Statistics ===");
		const sortedVersions = Array.from(stats.versionStats.entries())
			.filter(([_, versionStat]) => versionStat.mismatches > 0)
			.sort((a, b) => b[1].mismatches - a[1].mismatches);

		for (const [version, versionStat] of sortedVersions) {
			const versionMatchRate = (versionStat.matches / versionStat.total) * 100;
			logger.info(`${version}:`);
			logger.info(`  Total entries: ${versionStat.total.toLocaleString()}`);
			logger.info(
				`  Matches: ${versionStat.matches.toLocaleString()} (${versionMatchRate.toFixed(1)}%)`,
			);
			logger.info(`  Mismatches: ${versionStat.mismatches.toLocaleString()}`);
			logger.info(
				`  Avg % difference: ${versionStat.avgPercentDiff.toFixed(1)}%`,
			);
		}
	}

	// Show sample discrepancies
	if (stats.discrepancies.length > 0 && sampleCount > 0) {
		logger.info(`\n=== Sample Discrepancies (first ${sampleCount}) ===`);
		const samples = stats.discrepancies.slice(0, sampleCount);

		for (const disc of samples) {
			logger.info(`File: ${disc.file}`);
			logger.info(`Timestamp: ${disc.timestamp}`);
			logger.info(`Model: ${disc.model}`);
			logger.info(`Original cost: $${disc.originalCost.toFixed(6)}`);
			logger.info(`Calculated cost: $${disc.calculatedCost.toFixed(6)}`);
			logger.info(
				`Difference: $${disc.difference.toFixed(6)} (${disc.percentDiff.toFixed(2)}%)`,
			);
			logger.info(`Tokens: ${JSON.stringify(disc.usage)}`);
			logger.info("---");
		}
	}
}
