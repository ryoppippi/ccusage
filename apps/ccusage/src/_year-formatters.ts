/**
 * Formatters for year/wrapped report output
 */

import type { YearStats } from './_year-types.ts';
import { formatCurrency, formatTokens } from '@ccusage/internal/format';
import pc from 'picocolors';

/**
 * Format large numbers with abbreviations (M for million, K for thousand)
 */
function formatLargeNumber(num: number): string {
	if (num >= 1_000_000) {
		return `${(num / 1_000_000).toFixed(1)}M`;
	}
	if (num >= 1_000) {
		return `${(num / 1_000).toFixed(1)}K`;
	}
	return formatTokens(num);
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

/**
 * Format currency with 2 decimal places
 */
function formatCost(amount: number): string {
	return `$${amount.toFixed(2)}`;
}

/**
 * Create ASCII bar chart for monthly trend
 */
function createMonthlyBarChart(stats: YearStats): string {
	const maxTokens = Math.max(...stats.monthlyTrend.map(m => m.tokens), 1);
	const barWidth = 40;
	const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

	let chart = '';
	for (let i = 0; i < stats.monthlyTrend.length; i++) {
		const month = stats.monthlyTrend[i]!;
		const barLength = Math.round((month.tokens / maxTokens) * barWidth);
		const bar = '█'.repeat(barLength);
		const monthName = monthNames[i] ?? 'Unknown';
		const tokensStr = formatLargeNumber(month.tokens).padStart(8);

		chart += `  ${monthName}  ${pc.cyan(bar)}${' '.repeat(barWidth - barLength)} ${tokensStr} tokens\n`;
	}

	return chart;
}

/**
 * Create activity heatmap (GitHub-style)
 */
function createActivityHeatmap(stats: YearStats): string {
	const year = stats.year;
	let heatmap = '';

	// Get all dates sorted
	const startDate = new Date(`${year}-01-01T00:00:00Z`);
	const endDate = new Date(`${year}-12-31T00:00:00Z`);

	// Calculate which day of week Jan 1 falls on
	const startDayOfWeek = startDate.getUTCDay(); // 0 = Sunday

	// Create month labels
	const monthLabels = '     Jan   Feb   Mar   Apr   May   Jun   Jul   Aug   Sep   Oct   Nov   Dec';
	heatmap += pc.dim(monthLabels) + '\n';

	// Create day labels
	const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

	// Build heatmap grid (7 rows for days of week, ~53 columns for weeks)
	const weeks: Array<Array<{ date: string; level: number }>> = [];
	let currentWeek: Array<{ date: string; level: number }> = [];

	// Fill initial empty days
	for (let i = 0; i < startDayOfWeek; i++) {
		currentWeek.push({ date: '', level: 0 });
	}

	// Fill in all days of the year
	for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
		const dateKey = d.toISOString().split('T')[0]!;
		const activity = stats.dailyActivity.get(dateKey);
		const level = activity?.level ?? 0;

		currentWeek.push({ date: dateKey, level });

		if (currentWeek.length === 7) {
			weeks.push(currentWeek);
			currentWeek = [];
		}
	}

	// Push remaining days
	if (currentWeek.length > 0) {
		while (currentWeek.length < 7) {
			currentWeek.push({ date: '', level: 0 });
		}
		weeks.push(currentWeek);
	}

	// Render grid by rows (days of week)
	for (let day = 0; day < 7; day++) {
		const dayLabel = dayLabels[day]!.padEnd(3);
		let row = pc.dim(dayLabel) + '  ';

		for (const week of weeks) {
			const cell = week[day];
			if (!cell || cell.date === '') {
				row += ' ';
			}
			else {
				const char = getHeatmapChar(cell.level);
				row += char;
			}
		}

		heatmap += row + '\n';
	}

	// Add legend
	heatmap += '\n';
	heatmap += pc.dim('     Less ') + getHeatmapChar(0) + ' ' + getHeatmapChar(1) + ' ' + getHeatmapChar(2) + ' ' + getHeatmapChar(3) + ' ' + getHeatmapChar(4) + pc.dim(' More');

	return heatmap;
}

/**
 * Get character for heatmap level with color
 */
function getHeatmapChar(level: number): string {
	switch (level) {
		case 0:
			return pc.dim('·');
		case 1:
			return pc.yellow('■');
		case 2:
			return pc.yellow(pc.bold('■'));
		case 3:
			return pc.red('■');
		case 4:
			return pc.red(pc.bold('■'));
		default:
			return pc.dim('·');
	}
}

/**
 * Format hour in 12-hour format
 */
function formatHour(hour: number): string {
	if (hour === 0) return '12 AM';
	if (hour === 12) return '12 PM';
	if (hour < 12) return `${hour} AM`;
	return `${hour - 12} PM`;
}

/**
 * Format terminal output for year report
 */
export function formatYearTerminal(stats: YearStats): string {
	let output = '';

	// Header
	output += pc.bold(pc.cyan('\n╔══════════════════════════════════════════════════════════╗\n'));
	output += pc.bold(pc.cyan('║')) + '           🎉 Your ' + pc.bold(stats.year.toString()) + ' Claude Code Wrapped 🎉            ' + pc.bold(pc.cyan('║')) + '\n';
	output += pc.bold(pc.cyan('╚══════════════════════════════════════════════════════════╝\n\n'));

	// Overview section
	output += pc.bold(pc.cyan('📊 OVERVIEW\n'));
	output += pc.cyan('━'.repeat(60)) + '\n';
	output += `  Total Tokens:        ${pc.bold(formatLargeNumber(stats.totalTokens.total))} tokens\n`;
	output += `  Total Cost:          ${pc.bold(formatCost(stats.totalCost))} USD\n`;
	output += `  Active Days:         ${pc.bold(stats.activeDays.toString())} days\n`;
	output += `  Current Streak:      ${pc.bold(stats.currentStreak.toString())} days ${stats.currentStreak > 0 ? '🔥' : ''}\n`;
	output += `  Longest Streak:      ${pc.bold(stats.longestStreak.toString())} days\n`;
	output += `  Total Sessions:      ${pc.bold(stats.totalSessions.toString())}\n\n`;

	// Models section
	if (stats.modelBreakdown.length > 0) {
		output += pc.bold(pc.cyan('🤖 MODELS USED\n'));
		output += pc.cyan('━'.repeat(60)) + '\n';

		for (const model of stats.modelBreakdown.slice(0, 5)) {
			const tokensStr = formatLargeNumber(model.tokens).padStart(10);
			const percentStr = model.percentage.toFixed(1).padStart(5);
			const costStr = formatCost(model.cost).padStart(10);

			output += `  • ${pc.bold(model.model.padEnd(25))} ${tokensStr} tokens  ${percentStr}%  ${costStr}\n`;
		}
		output += '\n';
	}

	// Monthly trend
	output += pc.bold(pc.cyan('📈 MONTHLY TREND\n'));
	output += pc.cyan('━'.repeat(60)) + '\n';
	output += createMonthlyBarChart(stats);
	output += '\n';

	// Activity heatmap
	output += pc.bold(pc.cyan('🔥 ACTIVITY HEATMAP\n'));
	output += pc.cyan('━'.repeat(60)) + '\n';
	output += createActivityHeatmap(stats);
	output += '\n\n';

	// Top projects
	if (stats.topProjects.length > 0) {
		output += pc.bold(pc.cyan('🏆 TOP PROJECTS\n'));
		output += pc.cyan('━'.repeat(60)) + '\n';

		for (let i = 0; i < stats.topProjects.length; i++) {
			const project = stats.topProjects[i]!;
			const rank = (i + 1).toString().padStart(2);
			const tokensStr = formatLargeNumber(project.tokens).padStart(10);

			output += `  ${rank}. ${pc.bold(project.project.padEnd(30))} ${tokensStr} tokens\n`;
		}
		output += '\n';
	}

	// Insights
	output += pc.bold(pc.cyan('💡 INSIGHTS\n'));
	output += pc.cyan('━'.repeat(60)) + '\n';
	output += `  Most active hour:       ${pc.bold(formatHour(stats.peakHour))}\n`;
	output += `  Most active day:        ${pc.bold(stats.peakDayOfWeek)}\n`;

	if (stats.totalTokens.cache_read > 0) {
		const totalInput = stats.totalTokens.input + stats.totalTokens.cache_read;
		const cachePercentage = (stats.totalTokens.cache_read / totalInput) * 100;
		output += `  Cache read rate:        ${pc.bold(cachePercentage.toFixed(1) + '%')}\n`;
	}

	output += '\n';

	return output;
}

/**
 * Generate HTML output for year report
 */
export function generateYearHTML(stats: YearStats): string {
	const chartData = {
		labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
		data: stats.monthlyTrend.map(m => m.tokens),
	};

	// Generate heatmap HTML
	function generateHeatmapHTML(): string {
		const year = stats.year;
		const startDate = new Date(`${year}-01-01T00:00:00Z`);
		const endDate = new Date(`${year}-12-31T00:00:00Z`);
		const startDayOfWeek = startDate.getUTCDay();

		let html = '<div class="heatmap-container">';
		html += '<div class="heatmap-months">';

		const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
		for (const month of monthNames) {
			html += `<span>${month}</span>`;
		}
		html += '</div>';

		html += '<div class="heatmap-grid">';
		html += '<div class="heatmap-days">';
		html += '<span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span>';
		html += '</div>';
		html += '<div class="heatmap-cells">';

		// Add empty cells for days before year starts
		for (let i = 0; i < startDayOfWeek; i++) {
			html += '<div class="heatmap-cell level-0"></div>';
		}

		// Add all days
		for (let d = new Date(startDate); d <= endDate; d.setUTCDate(d.getUTCDate() + 1)) {
			const dateKey = d.toISOString().split('T')[0]!;
			const activity = stats.dailyActivity.get(dateKey);
			const level = activity?.level ?? 0;
			const tokens = activity?.tokens ?? 0;
			const title = `${dateKey}: ${formatLargeNumber(tokens)} tokens`;

			html += `<div class="heatmap-cell level-${level}" title="${title}" data-date="${dateKey}"></div>`;
		}

		html += '</div></div></div>';

		return html;
	}

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${stats.year} Claude Code Wrapped</title>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            background: linear-gradient(135deg, #1e1e1e 0%, #2d2d2d 100%);
            color: #e0e0e0;
            padding: 20px;
            line-height: 1.6;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: #252525;
            border-radius: 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #ff6b35 0%, #ff8c42 100%);
            padding: 60px 40px;
            text-align: center;
            color: white;
        }

        .header h1 {
            font-size: 3em;
            font-weight: 700;
            margin-bottom: 10px;
        }

        .header p {
            font-size: 1.2em;
            opacity: 0.95;
        }

        .content {
            padding: 40px;
        }

        .section {
            margin-bottom: 50px;
        }

        .section-title {
            font-size: 1.8em;
            font-weight: 600;
            margin-bottom: 25px;
            color: #ff8c42;
            display: flex;
            align-items: center;
            gap: 10px;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }

        .stat-card {
            background: #1e1e1e;
            padding: 25px;
            border-radius: 12px;
            border: 1px solid #3a3a3a;
            transition: transform 0.2s, border-color 0.2s;
        }

        .stat-card:hover {
            transform: translateY(-2px);
            border-color: #ff8c42;
        }

        .stat-label {
            font-size: 0.9em;
            color: #999;
            margin-bottom: 8px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }

        .stat-value {
            font-size: 2em;
            font-weight: 700;
            color: #ff8c42;
            margin-bottom: 5px;
        }

        .stat-unit {
            font-size: 0.85em;
            color: #bbb;
        }

        .model-list {
            list-style: none;
        }

        .model-item {
            background: #1e1e1e;
            padding: 20px;
            margin-bottom: 12px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-left: 4px solid #ff8c42;
        }

        .model-name {
            font-weight: 600;
            font-size: 1.1em;
        }

        .model-stats {
            display: flex;
            gap: 30px;
            color: #999;
        }

        .model-stat-item {
            text-align: right;
        }

        .model-stat-label {
            font-size: 0.8em;
            display: block;
            margin-bottom: 4px;
        }

        .model-stat-value {
            font-size: 1.1em;
            font-weight: 600;
            color: #e0e0e0;
        }

        .chart-container {
            background: #1e1e1e;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
            height: 400px;
        }

        .heatmap-container {
            background: #1e1e1e;
            padding: 20px;
            border-radius: 12px;
            overflow-x: auto;
            overflow-y: hidden;
            max-width: 100%;
        }

        .heatmap-months {
            display: grid;
            grid-template-columns: repeat(12, 1fr);
            gap: 3px;
            margin-bottom: 8px;
            padding-left: 28px;
            font-size: 0.7em;
            color: #999;
            min-width: 700px;
        }

        .heatmap-grid {
            display: flex;
            gap: 4px;
            min-width: 700px;
        }

        .heatmap-days {
            display: flex;
            flex-direction: column;
            gap: 1.5px;
            font-size: 0.65em;
            color: #999;
            padding-top: 1px;
        }

        .heatmap-days span {
            height: 9px;
            display: flex;
            align-items: center;
        }

        .heatmap-cells {
            display: grid;
            grid-template-columns: repeat(53, 9px);
            grid-auto-flow: column;
            gap: 1.5px;
        }

        .heatmap-cell {
            width: 9px;
            height: 9px;
            border-radius: 2px;
            transition: transform 0.2s;
            cursor: pointer;
        }

        .heatmap-cell:hover {
            transform: scale(1.5);
            z-index: 10;
        }

        .heatmap-cell.level-0 {
            background: #2d2d2d;
        }

        .heatmap-cell.level-1 {
            background: #ff8c4244;
        }

        .heatmap-cell.level-2 {
            background: #ff8c4288;
        }

        .heatmap-cell.level-3 {
            background: #ff8c42cc;
        }

        .heatmap-cell.level-4 {
            background: #ff8c42;
        }

        .project-list {
            list-style: none;
        }

        .project-item {
            background: #1e1e1e;
            padding: 18px 25px;
            margin-bottom: 10px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .project-rank {
            font-weight: 700;
            font-size: 1.5em;
            color: #ff8c42;
            margin-right: 15px;
        }

        .project-name {
            flex: 1;
            font-size: 1.05em;
        }

        .project-tokens {
            font-weight: 600;
            color: #bbb;
        }

        .insights-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
        }

        .insight-card {
            background: #1e1e1e;
            padding: 20px;
            border-radius: 8px;
            border-left: 3px solid #ff8c42;
        }

        .insight-label {
            font-size: 0.9em;
            color: #999;
            margin-bottom: 8px;
        }

        .insight-value {
            font-size: 1.5em;
            font-weight: 600;
            color: #ff8c42;
        }

        .footer {
            text-align: center;
            padding: 40px;
            color: #666;
            border-top: 1px solid #3a3a3a;
        }

        .buttons {
            display: flex;
            gap: 15px;
            justify-content: center;
            margin-top: 30px;
        }

        .btn {
            padding: 12px 30px;
            border: none;
            border-radius: 8px;
            font-size: 1em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            text-decoration: none;
            display: inline-block;
        }

        .btn-primary {
            background: linear-gradient(135deg, #ff6b35 0%, #ff8c42 100%);
            color: white;
        }

        .btn-primary:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(255, 107, 53, 0.4);
        }

        .btn-secondary {
            background: #1e1e1e;
            color: #e0e0e0;
            border: 1px solid #3a3a3a;
        }

        .btn-secondary:hover {
            border-color: #ff8c42;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 2em;
            }

            .content {
                padding: 20px;
            }

            .stats-grid {
                grid-template-columns: 1fr;
            }

            .model-stats {
                flex-direction: column;
                gap: 10px;
                align-items: flex-end;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🎉 ${stats.year} Claude Code Wrapped</h1>
            <p>Your year in AI-powered development</p>
        </div>

        <div class="content">
            <!-- Overview Stats -->
            <div class="section">
                <h2 class="section-title">📊 Overview</h2>
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-label">TOTAL TOKENS</div>
                        <div class="stat-value">${formatLargeNumber(stats.totalTokens.total)}</div>
                        <div class="stat-unit">tokens</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">TOTAL COST</div>
                        <div class="stat-value">${formatCost(stats.totalCost)}</div>
                        <div class="stat-unit">USD</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">ACTIVE DAYS</div>
                        <div class="stat-value">${stats.activeDays}</div>
                        <div class="stat-unit">days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">CURRENT STREAK</div>
                        <div class="stat-value">${stats.currentStreak} ${stats.currentStreak > 0 ? '🔥' : ''}</div>
                        <div class="stat-unit">days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">LONGEST STREAK</div>
                        <div class="stat-value">${stats.longestStreak}</div>
                        <div class="stat-unit">days</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-label">SESSIONS</div>
                        <div class="stat-value">${stats.totalSessions}</div>
                        <div class="stat-unit">total</div>
                    </div>
                    ${stats.modelBreakdown.length > 0 && stats.modelBreakdown[0] ? `
                    <div class="stat-card">
                        <div class="stat-label">PRIMARY MODEL</div>
                        <div class="stat-value" style="font-size: 1.2em;">${stats.modelBreakdown[0]!.model.replace('claude-', '').replace('-20250929', '').replace('-20251001', '')}</div>
                        <div class="stat-unit">${stats.modelBreakdown[0]!.percentage.toFixed(1)}% usage</div>
                    </div>
                    ` : ''}
                    <div class="stat-card">
                        <div class="stat-label">MOST ACTIVE DAY</div>
                        <div class="stat-value">${stats.peakDayOfWeek}</div>
                        <div class="stat-unit">of the week</div>
                    </div>
                </div>
            </div>

            <!-- Monthly Trend -->
            <div class="section">
                <h2 class="section-title">📈 Monthly Trend</h2>
                <div class="chart-container">
                    <canvas id="monthlyChart"></canvas>
                </div>
            </div>

            <!-- Activity Heatmap -->
            <div class="section">
                <h2 class="section-title">🔥 Activity Heatmap</h2>
                ${generateHeatmapHTML()}
            </div>

        </div>

        <div class="footer">
            <p>Generated with <strong>ccusage</strong> - Claude Code Usage Analysis Tool</p>
            <p style="margin-top: 10px;">
                <a href="https://github.com/ryoppippi/ccusage" style="color: #ff8c42; text-decoration: none;">github.com/ryoppippi/ccusage</a>
            </p>
        </div>
    </div>

    <script>
        // Monthly trend chart
        const ctx = document.getElementById('monthlyChart').getContext('2d');
        new Chart(ctx, {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(chartData.labels)},
                datasets: [{
                    label: 'Tokens',
                    data: ${JSON.stringify(chartData.data)},
                    backgroundColor: 'rgba(255, 140, 66, 0.7)',
                    borderColor: 'rgba(255, 140, 66, 1)',
                    borderWidth: 2,
                    borderRadius: 6,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                scales: {
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: '#3a3a3a'
                        },
                        ticks: {
                            color: '#999',
                            callback: function(value) {
                                if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M';
                                if (value >= 1000) return (value / 1000).toFixed(1) + 'K';
                                return value;
                            }
                        }
                    },
                    x: {
                        grid: {
                            display: false
                        },
                        ticks: {
                            color: '#999'
                        }
                    }
                }
            }
        });
    </script>
</body>
</html>`;

	return html;
}
