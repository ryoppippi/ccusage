import { defineConfig } from 'vitepress';
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons';
import llmstxt from 'vitepress-plugin-llms';
import { withMermaid } from 'vitepress-plugin-mermaid';

export default withMermaid(defineConfig({
	title: 'ccusage',
	description: 'Usage analysis tool for Claude Code',
	base: '/',
	cleanUrls: true,
	ignoreDeadLinks: true,

	head: [
		['link', { rel: 'icon', href: '/favicon.svg' }],
		['meta', { name: 'theme-color', content: '#646cff' }],
		['meta', { property: 'og:type', content: 'website' }],
		['meta', { property: 'og:locale', content: 'en' }],
		['meta', { property: 'og:title', content: 'ccusage | Claude Code Usage Analysis' }],
		['meta', { property: 'og:site_name', content: 'ccusage' }],
		['meta', { property: 'og:image', content: 'https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/logo.svg' }],
		['meta', { property: 'og:url', content: 'https://github.com/ryoppippi/ccusage' }],
	],

	themeConfig: {
		logo: '/logo.svg',

		nav: [
			{ text: 'Guide', link: '/guide/' },
			{ text: 'API Reference', link: '/api/' },
			{
				text: 'Links',
				items: [
					{ text: 'GitHub', link: 'https://github.com/ryoppippi/ccusage' },
					{ text: 'npm', link: 'https://www.npmjs.com/package/ccusage' },
					{ text: 'Changelog', link: 'https://github.com/ryoppippi/ccusage/releases' },
				],
			},
		],

		sidebar: {
			'/guide/': [
				{
					text: 'Introduction',
					items: [
						{ text: 'Introduction', link: '/guide/' },
						{ text: 'Getting Started', link: '/guide/getting-started' },
						{ text: 'Installation', link: '/guide/installation' },
					],
				},
				{
					text: 'Usage',
					items: [
						{ text: 'Daily Reports', link: '/guide/daily-reports' },
						{ text: 'Monthly Reports', link: '/guide/monthly-reports' },
						{ text: 'Session Reports', link: '/guide/session-reports' },
						{ text: 'Blocks Reports', link: '/guide/blocks-reports' },
						{ text: 'Live Monitoring', link: '/guide/live-monitoring' },
					],
				},
				{
					text: 'Configuration',
					items: [
						{ text: 'Environment Variables', link: '/guide/configuration' },
						{ text: 'Custom Paths', link: '/guide/custom-paths' },
						{ text: 'Cost Calculation Modes', link: '/guide/cost-modes' },
					],
				},
				{
					text: 'Integration',
					items: [
						{ text: 'MCP Server', link: '/guide/mcp-server' },
						{ text: 'JSON Output', link: '/guide/json-output' },
					],
				},
				{
					text: 'Community',
					items: [
						{ text: 'Related Projects', link: '/guide/related-projects' },
					],
				},
			],
			'/api/': [
				{
					text: 'API Reference',
					items: [
						{ text: 'Overview', link: '/api/' },
						{ text: 'Data Loader', link: '/api/data-loader' },
						{ text: 'Calculate Cost', link: '/api/calculate-cost' },
						{ text: 'MCP Server', link: '/api/mcp' },
						{ text: 'Types', link: '/api/types' },
					],
				},
			],
		},

		socialLinks: [
			{ icon: 'github', link: 'https://github.com/ryoppippi/ccusage' },
			{ icon: 'npm', link: 'https://www.npmjs.com/package/ccusage' },
		],

		footer: {
			message: 'Released under the MIT License.',
			copyright: 'Copyright © 2024 ryoppippi',
		},

		search: {
			provider: 'local',
		},

		editLink: {
			pattern: 'https://github.com/ryoppippi/ccusage/edit/main/docs/:path',
			text: 'Edit this page on GitHub',
		},

		lastUpdated: {
			text: 'Updated at',
			formatOptions: {
				dateStyle: 'full',
				timeStyle: 'medium',
			},
		},
	},

	vite: {
		plugins: [
			groupIconVitePlugin(),
			...llmstxt(),
		],
	},

	markdown: {
		config(md) {
			md.use(groupIconMdPlugin);
		},
	},
	mermaid: {
		// Optional mermaid configuration
	},
}));
