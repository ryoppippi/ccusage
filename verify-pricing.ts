#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { glob } from "tinyglobby";
import * as v from "valibot";
import path from "node:path";
import { homedir } from "node:os";
import { UsageDataSchema } from "./data-loader.ts";
import {
	fetchModelPricing,
	getModelPricing,
	calculateCostFromTokens,
} from "./pricing-fetcher.ts";

// Find JSONL files that have both costUSD and model fields
const claudeDir = path.join(homedir(), ".claude", "projects");
const files = await glob(["**/*.jsonl"], {
	cwd: claudeDir,
	absolute: true,
});

console.log(`Found ${files.length} JSONL files to check\n`);

// Fetch pricing data
const modelPricing = await fetchModelPricing();
console.log(`Loaded pricing for ${Object.keys(modelPricing).length} models\n`);

let totalEntries = 0;
let entriesWithBoth = 0;
let matches = 0;
let mismatches = 0;
const discrepancies: Array<{
	file: string;
	timestamp: string;
	model: string;
	originalCost: number;
	calculatedCost: number;
	difference: number;
	percentDiff: number;
	usage: any;
}> = [];

// Track model statistics
const modelStats = new Map<
	string,
	{
		total: number;
		matches: number;
		mismatches: number;
		avgPercentDiff: number;
	}
>();

// Track session versions
const sessionVersions = new Map<string, Set<string>>();

// Track version statistics
const versionStats = new Map<
	string,
	{
		total: number;
		matches: number;
		mismatches: number;
		avgPercentDiff: number;
	}
>();

// Track session mismatches by version
const sessionMismatchesByVersion = new Map<string, Map<string, { total: number; mismatches: number }>>();

for (const file of files) {
	// Extract session info from file path
	const relativePath = path.relative(claudeDir, file);
	const parts = relativePath.split(path.sep);
	const sessionId = parts[parts.length - 2];
	const projectPath = parts.slice(0, -2).join(path.sep);
	const sessionKey = `${projectPath}/${sessionId}`;

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
			totalEntries++;

			// Collect version information for this session
			if (data.version) {
				if (!sessionVersions.has(sessionKey)) {
					sessionVersions.set(sessionKey, new Set<string>());
				}
				sessionVersions.get(sessionKey)!.add(data.version);
			}

			// Check if we have both costUSD and model
			if (
				data.costUSD !== undefined &&
				data.message.model &&
				data.message.model !== "<synthetic>"
			) {
				entriesWithBoth++;

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
					const stats = modelStats.get(model) || {
						total: 0,
						matches: 0,
						mismatches: 0,
						avgPercentDiff: 0,
					};
					stats.total++;

					// Update version statistics if version is available
					if (data.version) {
						const vStats = versionStats.get(data.version) || {
							total: 0,
							matches: 0,
							mismatches: 0,
							avgPercentDiff: 0,
						};
						vStats.total++;

						// Track session-level stats for this version
						if (!sessionMismatchesByVersion.has(data.version)) {
							sessionMismatchesByVersion.set(data.version, new Map());
						}
						const sessionStatsMap = sessionMismatchesByVersion.get(data.version)!;
						
						if (!sessionStatsMap.has(sessionKey)) {
							sessionStatsMap.set(sessionKey, { total: 0, mismatches: 0 });
						}
						const sessionStats = sessionStatsMap.get(sessionKey)!;
						sessionStats.total++;

						// Consider it a match if within 0.1% difference (to account for floating point)
						if (percentDiff < 0.1) {
							vStats.matches++;
						} else {
							vStats.mismatches++;
							sessionStats.mismatches++;
						}

						// Update average percent difference for version
						vStats.avgPercentDiff =
							(vStats.avgPercentDiff * (vStats.total - 1) + percentDiff) /
							vStats.total;
						versionStats.set(data.version, vStats);
					}

					// Consider it a match if within 0.1% difference (to account for floating point)
					if (percentDiff < 0.1) {
						matches++;
						stats.matches++;
					} else {
						mismatches++;
						stats.mismatches++;
						discrepancies.push({
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
					stats.avgPercentDiff =
						(stats.avgPercentDiff * (stats.total - 1) + percentDiff) /
						stats.total;
					modelStats.set(model, stats);
				}
			}
		} catch (e) {
			// Skip invalid JSON
		}
	}
}

console.log("=== Verification Results ===\n");
console.log(`Total entries processed: ${totalEntries.toLocaleString()}`);
console.log(
	`Entries with both costUSD and model: ${entriesWithBoth.toLocaleString()}`,
);
console.log(`Matches (within 0.1%): ${matches.toLocaleString()}`);
console.log(`Mismatches: ${mismatches.toLocaleString()}`);

if (entriesWithBoth > 0) {
	const matchRate = (matches / entriesWithBoth) * 100;
	console.log(`\nMatch rate: ${matchRate.toFixed(2)}%`);
}

// Show model-by-model breakdown
console.log("\n=== Model Statistics ===\n");
const sortedModels = Array.from(modelStats.entries()).sort(
	(a, b) => b[1].total - a[1].total,
);

for (const [model, stats] of sortedModels) {
	const matchRate = (stats.matches / stats.total) * 100;
	console.log(`${model}:`);
	console.log(`  Total entries: ${stats.total.toLocaleString()}`);
	console.log(
		`  Matches: ${stats.matches.toLocaleString()} (${matchRate.toFixed(1)}%)`,
	);
	console.log(`  Mismatches: ${stats.mismatches.toLocaleString()}`);
	if (stats.mismatches > 0) {
		console.log(`  Avg % difference: ${stats.avgPercentDiff.toFixed(1)}%`);
	}
	console.log();
}

// Show version statistics
console.log("\n=== Version Statistics ===\n");
const sortedVersions = Array.from(versionStats.entries()).sort(
	(a, b) => a[0].localeCompare(b[0]),
);

for (const [version, stats] of sortedVersions) {
	const matchRate = (stats.matches / stats.total) * 100;
	console.log(`${version}:`);
	console.log(`  Total entries: ${stats.total.toLocaleString()}`);
	console.log(
		`  Matches: ${stats.matches.toLocaleString()} (${matchRate.toFixed(1)}%)`,
	);
	console.log(`  Mismatches: ${stats.mismatches.toLocaleString()}`);
	if (stats.mismatches > 0) {
		console.log(`  Avg % difference: ${stats.avgPercentDiff.toFixed(1)}%`);
	}
	console.log();
}

// Show sample discrepancies (limit to 20)
if (discrepancies.length > 0) {
	console.log("\n=== Sample Discrepancies (first 20) ===\n");
	const samples = discrepancies;

	for (const disc of samples) {
		console.log(`File: ${disc.file}`);
		console.log(`Timestamp: ${disc.timestamp}`);
		console.log(`Model: ${disc.model}`);
		console.log(`Original cost: $${disc.originalCost.toFixed(6)}`);
		console.log(`Calculated cost: $${disc.calculatedCost.toFixed(6)}`);
		console.log(
			`Difference: $${disc.difference.toFixed(6)} (${disc.percentDiff.toFixed(2)}%)`,
		);
		console.log(`Tokens: ${JSON.stringify(disc.usage)}`);
		console.log("---");
	}
}

// Analyze discrepancy patterns
console.log("\n=== Discrepancy Analysis ===\n");
const discrepancyPatterns = new Map<number, number>();
for (const disc of discrepancies) {
	const ratio = disc.calculatedCost / disc.originalCost;
	const roundedRatio = Math.round(ratio * 10) / 10; // Round to nearest 0.1
	discrepancyPatterns.set(
		roundedRatio,
		(discrepancyPatterns.get(roundedRatio) || 0) + 1,
	);
}

console.log("Cost ratio patterns (calculated/original):");
const sortedPatterns = Array.from(discrepancyPatterns.entries()).sort(
	(a, b) => b[1] - a[1],
);
for (const [ratio, count] of sortedPatterns) {
	const percentage = (count / mismatches) * 100;
	console.log(
		`  ${ratio.toFixed(1)}x: ${count} occurrences (${percentage.toFixed(1)}%)`,
	);
}

// Show session mismatch rates by version
if (sessionMismatchesByVersion.size > 0) {
	console.log("\n=== Session Mismatch Rates by Version ===\n");
	const sortedVersions = Array.from(sessionMismatchesByVersion.entries()).sort(
		(a, b) => a[0].localeCompare(b[0]),
	);

	for (const [version, sessionMap] of sortedVersions) {
		console.log(`Version ${version}:`);
		
		// Calculate sessions with mismatches
		const sessionsWithMismatches = Array.from(sessionMap.entries())
			.filter(([_, stats]) => stats.mismatches > 0);
		
		console.log(`  Sessions with mismatches: ${sessionsWithMismatches.length} out of ${sessionMap.size}`);
		
		// Show sessions with highest mismatch rates
		const sessionMismatchRates = sessionsWithMismatches
			.map(([session, stats]) => ({
				session,
				mismatchRate: (stats.mismatches / stats.total) * 100,
				mismatches: stats.mismatches,
				total: stats.total
			}))
			.sort((a, b) => b.mismatchRate - a.mismatchRate);
		
		if (sessionMismatchRates.length > 0) {
			console.log("  Top sessions with mismatches:");
			const topSessions = sessionMismatchRates.slice(0, 5);
			for (const { session, mismatchRate, mismatches, total } of topSessions) {
				console.log(`    ${session}: ${mismatchRate.toFixed(1)}% (${mismatches}/${total})`);
			}
		}
		console.log();
	}
}

// Show session versions
if (sessionVersions.size > 0) {
	console.log("\n=== Session Versions ===\n");
	const sortedSessions = Array.from(sessionVersions.entries()).sort(
		(a, b) => a[0].localeCompare(b[0]),
	);

	for (const [sessionPath, versions] of sortedSessions) {
		const versionList = Array.from(versions).sort().join(", ");
		console.log(`${sessionPath}: ${versionList}`);
	}
}
