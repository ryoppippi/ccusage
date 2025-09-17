import { defineConfig } from 'vitepress';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { groupIconMdPlugin, groupIconVitePlugin } from 'vitepress-plugin-group-icons';
import llmstxt from 'vitepress-plugin-llms';
import type { DefaultTheme } from 'vitepress';
import { cloudflareRedirect } from '@ryoppippi/vite-plugin-cloudflare-redirect';


const typedocSidebarJson = fs.readFileSync(path.join(import.meta.dirname, '../api/typedoc-sidebar.json'))
const typedocSidebar = JSON.parse(typedocSidebarJson.toString()) as DefaultTheme.SidebarItem[];

export default defineConfig({
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
		['meta', { property: 'og:image', content: 'https://cdn.jsdelivr.net/gh/ryoppippi/ccusage@main/docs/public/logo.png' }],
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
					{ text: 'DeepWiki', link: 'https://deepwiki.com/ryoppippi/ccusage' },
					{ text: 'Package Stats', link: 'https://tanstack.com/ccusage?npmPackage=ccusage' },
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
						{ text: 'Weekly Reports', link: '/guide/weekly-reports' },
						{ text: 'Monthly Reports', link: '/guide/monthly-reports' },
						{ text: 'Session Reports', link: '/guide/session-reports' },
						{ text: 'Blocks Reports', link: '/guide/blocks-reports' },
						{ text: 'Live Monitoring', link: '/guide/live-monitoring' },
					],
				},
				{
					text: 'Configuration',
					items: [
						{ text: 'Overview', link: '/guide/configuration' },
						{ text: 'Command-Line Options', link: '/guide/cli-options' },
						{ text: 'Environment Variables', link: '/guide/environment-variables' },
						{ text: 'Configuration Files', link: '/guide/config-files' },
						{ text: 'Directory Detection', link: '/guide/directory-detection' },
						{ text: 'Custom Paths', link: '/guide/custom-paths' },
						{ text: 'Cost Calculation Modes', link: '/guide/cost-modes' },
					],
				},
				{
					text: 'Integration',
					items: [
						{ text: 'Library Usage', link: '/guide/library-usage' },
						{ text: 'MCP Server', link: '/guide/mcp-server' },
						{ text: 'JSON Output', link: '/guide/json-output' },
						{ text: 'Statusline Integration', link: '/guide/statusline' },
					],
				},
				{
					text: 'Community',
					items: [
						{ text: 'Related Projects', link: '/guide/related-projects' },
						{ text: 'Sponsors', link: '/guide/sponsors' },
					],
				},
			],
			'/api/': [
				{
					text: 'API Reference',
					items: [
						{ text: 'Overview', link: '/api/' },
						...typedocSidebar,
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
			copyright: 'Copyright © 2025 ryoppippi',
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
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false,
				timeZone: 'UTC',
			},
		},
	},

	vite: {
		plugins: [
			cloudflareRedirect({
            mode: "generate",
            entries: [
                { from: '/raycast', to: 'https://www.raycast.com/nyatinte/ccusage', status: 302 },
                { from: '/gh', to: 'https://github.com/ryoppippi/ccusage', status: 302 },
                { from: '/npm', to: 'https://www.npmjs.com/package/ccusage', status: 302 },
                { from: '/deepwiki', to: 'https://deepwiki.com/ryoppippi/ccusage', status: 302 },
            ]
        }) as any,
			groupIconVitePlugin(),
			...llmstxt(),
		],
	},

	markdown: {
		config(md) {
			md.use(groupIconMdPlugin);
		},
	},
});
