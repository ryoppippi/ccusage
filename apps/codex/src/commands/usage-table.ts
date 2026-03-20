import type { TableCellAlign } from '@ccusage/terminal/table';
import { formatDateCompact, ResponsiveTable } from '@ccusage/terminal/table';

type UsageTableMode = 'daily' | 'monthly' | 'session';

type UsageTableSchema = {
	head: string[];
	colAligns: TableCellAlign[];
	compactHead: string[];
	compactColAligns: TableCellAlign[];
};

type CreateUsageResponsiveTableOptions = {
	mode: UsageTableMode;
	includeAccountColumn: boolean;
	forceCompact?: boolean;
};

const COMPACT_THRESHOLD = 100;

function createPeriodicUsageTableSchema(
	label: 'Date' | 'Month',
	includeAccountColumn: boolean,
): UsageTableSchema {
	if (includeAccountColumn) {
		return {
			head: [
				label,
				'Account',
				'Models',
				'Input',
				'Output',
				'Reasoning',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: [label, 'Account', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'left', 'right', 'right', 'right'],
		};
	}

	return {
		head: [
			label,
			'Models',
			'Input',
			'Output',
			'Reasoning',
			'Cache Read',
			'Total Tokens',
			'Cost (USD)',
		],
		colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
		compactHead: [label, 'Models', 'Input', 'Output', 'Cost (USD)'],
		compactColAligns: ['left', 'left', 'right', 'right', 'right'],
	};
}

function createSessionUsageTableSchema(includeAccountColumn: boolean): UsageTableSchema {
	if (includeAccountColumn) {
		return {
			head: [
				'Date',
				'Account',
				'Directory',
				'Session',
				'Models',
				'Input',
				'Output',
				'Reasoning',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
				'Last Activity',
			],
			colAligns: [
				'left',
				'left',
				'left',
				'left',
				'left',
				'right',
				'right',
				'right',
				'right',
				'right',
				'right',
				'left',
			],
			compactHead: ['Date', 'Account', 'Directory', 'Session', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'left', 'left', 'right', 'right', 'right'],
		};
	}

	return {
		head: [
			'Date',
			'Directory',
			'Session',
			'Models',
			'Input',
			'Output',
			'Reasoning',
			'Cache Read',
			'Total Tokens',
			'Cost (USD)',
			'Last Activity',
		],
		colAligns: [
			'left',
			'left',
			'left',
			'left',
			'right',
			'right',
			'right',
			'right',
			'right',
			'right',
			'left',
		],
		compactHead: ['Date', 'Directory', 'Session', 'Input', 'Output', 'Cost (USD)'],
		compactColAligns: ['left', 'left', 'left', 'right', 'right', 'right'],
	};
}

function getUsageTableSchema(
	mode: UsageTableMode,
	includeAccountColumn: boolean,
): UsageTableSchema {
	switch (mode) {
		case 'daily': {
			return createPeriodicUsageTableSchema('Date', includeAccountColumn);
		}
		case 'monthly': {
			return createPeriodicUsageTableSchema('Month', includeAccountColumn);
		}
		case 'session': {
			return createSessionUsageTableSchema(includeAccountColumn);
		}
		default: {
			throw new Error('Unsupported table mode');
		}
	}
}

export function createUsageResponsiveTable(options: CreateUsageResponsiveTableOptions): {
	table: ResponsiveTable;
	tableColumnCount: number;
} {
	const schema = getUsageTableSchema(options.mode, options.includeAccountColumn);
	const table = new ResponsiveTable({
		head: schema.head,
		colAligns: schema.colAligns,
		compactHead: schema.compactHead,
		compactColAligns: schema.compactColAligns,
		compactThreshold: COMPACT_THRESHOLD,
		forceCompact: options.forceCompact,
		style: { head: ['cyan'] },
		dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
	});

	return {
		table,
		tableColumnCount: schema.head.length,
	};
}
