import { regex } from 'arkregex';
import packageJson from '../package.json' with { type: 'json' };

type NodeVersion = readonly [number, number, number];

const nodeEngineRangeRegex = regex('^>=(\\d+)\\.(\\d+)\\.(\\d+)$');

export function getSupportedNodeRuntime(): { minimum: NodeVersion; range: string } {
	const range = packageJson.engines.node;
	const match = nodeEngineRangeRegex.exec(range);
	if (match == null) {
		throw new Error(`Unsupported Node.js engine range: ${range}`);
	}

	return {
		minimum: [Number(match[1]), Number(match[2]), Number(match[3])],
		range,
	};
}
