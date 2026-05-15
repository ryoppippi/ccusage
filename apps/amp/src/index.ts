#!/usr/bin/env node

import process from 'node:process';
import { runDeprecatedAgentCli } from '@ccusage/internal/deprecated-agent-cli';

// eslint-disable-next-line antfu/no-top-level-await
process.exitCode = await runDeprecatedAgentCli({
	agent: 'amp',
	binaryName: 'ccusage-amp',
	packageName: '@ccusage/amp',
});
