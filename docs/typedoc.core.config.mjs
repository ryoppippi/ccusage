// @ts-check
import { globSync } from 'tinyglobby'

const entryPoints = [
	...globSync([
		'../packages/core/src/*.ts',
		'!../packages/core/src/index.ts', // Exclude empty index
		'!../packages/core/src/**/*.test.ts', // Exclude test files
	], {
		absolute: true,
		onlyFiles: true,
		cwd: import.meta.dirname,
	}),
]

console.log('Entry points for TypeDoc:', entryPoints);

/** @type {import('typedoc').TypeDocOptions & import('typedoc-plugin-markdown').PluginOptions & { docsRoot?: string } } */
export default {
	// typedoc options
	// ref: https://typedoc.org/documents/Options.html
	entryPoints,
	entryPointStrategy: 'expand',
	categorizeByGroup: false,
	treatWarningsAsErrors: false,
	tsconfig: '../packages/core/tsconfig.json',
	out: 'api/core',
	plugin: ['typedoc-plugin-markdown', 'typedoc-vitepress-theme'],
	readme: 'none',
	excludeInternal: true,
	excludePrivate: true,
	excludeProtected: false,
	excludeNotDocumented: false,
	externalPattern: ['**/node_modules/**'],
	exclude: [
		'**/node_modules/**/*.test.ts',
		'**/src/**/*.test.ts',
		'**/*test*',
		'**/vitest*'
	],
	modifierTags: ['@internal', '@alpha', '@beta'],
	blockTags: ['@fileoverview', '@param', '@returns', '@throws', '@example'],
	inlineTags: ['@link', '@linkcode', '@linkplain'],
	groupOrder: ['Variables', 'Functions', 'Class'],
	categoryOrder: ['*', 'Other'],
	sort: ['source-order'],

	// typedoc-plugin-markdown options
	// ref: https://typedoc-plugin-markdown.org/docs/options
	entryFileName: 'index',
	flattenOutputFiles: false, // This should preserve module structure
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
