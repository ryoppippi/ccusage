// @ts-check
import { globSync } from 'tinyglobby'

const entryPoints = [
	...globSync([
		'../packages/ccusage-core/src/*.ts',
		'!../packages/ccusage-core/src/**/*.test.ts', // Exclude test files
		'!../packages/ccusage-core/src/_*.ts', // Exclude internal files with underscore prefix
	], {
		absolute: false,
		onlyFiles: true,
	}),
	'../packages/ccusage/src/_consts.ts', // Include constants for documentation
];

/** @type {import('typedoc').TypeDocOptions & import('typedoc-plugin-markdown').PluginOptions & { docsRoot?: string } } */
export default {
	// typedoc options
	// ref: https://typedoc.org/documents/Options.html
	entryPoints,
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
};
