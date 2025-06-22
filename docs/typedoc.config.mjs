// @ts-check
import fg from 'fast-glob';

const entryPoints = [
	...fg.sync([
		'../src/*.ts',
		'!../src/**/*.test.ts', // Exclude test files
		'!../src/_*.ts', // Exclude internal files with underscore prefix
	], {
		absolute: false,
		onlyFiles: true,
	}),
	'../src/_consts.ts', // Include constants for documentation
];

/** @type {import('typedoc').TypeDocOptions & import('typedoc-plugin-markdown').PluginOptions & { docsRoot?: string } } */
export default {
	// typedoc options
	// ref: https://typedoc.org/documents/Options.html
	entryPoints,
	tsconfig: '../tsconfig.json',
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
