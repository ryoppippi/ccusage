import type { TypeDocOptions } from 'typedoc';
import type { PluginOptions } from 'typedoc-plugin-markdown';
import { globSync } from 'tinyglobby';

type TypedocConfig = TypeDocOptions & PluginOptions & { docsRoot?: string };

const entryPoints = [
	...globSync([
		'./node_modules/better-ccusage/src/*.ts',
		'!./node_modules/better-ccusage/src/**/*.test.ts', // Exclude test files
		'!./node_modules/better-ccusage/src/_*.ts', // Exclude internal files with underscore prefix
	], {
		absolute: false,
		onlyFiles: true,
	}),
	'./node_modules/better-ccusage/src/_consts.ts', // Include constants for documentation
];

export default {
	// typedoc options
	// ref: https://typedoc.org/documents/Options.html
	entryPoints,
	tsconfig: './node_modules/better-ccusage/tsconfig.json',
	out: 'api',
	plugin: ['typedoc-plugin-markdown', 'typedoc-vitepress-theme'],
	readme: 'none',
	excludeInternal: true,
	groupOrder: ['Variables', 'Functions', 'Class'],
	categoryOrder: ['*', 'Other'],
	sort: ['source-order'],

	// typedoc-plugin-markdown options
	// ref: https://typedoc-plugin-markdown.org/docs/options
	entryFileName: 'index',
	hidePageTitle: false,
	useCodeBlocks: true,
	disableSources: true,
	indexFormat: 'table',
	parametersFormat: 'table',
	interfacePropertiesFormat: 'table',
	classPropertiesFormat: 'table',
	propertyMembersFormat: 'table',
	typeAliasPropertiesFormat: 'table',
	enumMembersFormat: 'table',

	// typedoc-vitepress-theme options
	// ref: https://typedoc-plugin-markdown.org/plugins/vitepress/options
	docsRoot: '.',
} satisfies TypedocConfig;
