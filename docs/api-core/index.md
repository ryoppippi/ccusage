# @ccusage/core

## Functions

| Function | Description |
| ------ | ------ |
| [formatNumber](functions/formatNumber.md) | Formats a number with locale-specific thousand separators |
| [formatCurrency](functions/formatCurrency.md) | Formats a number as USD currency with dollar sign and 2 decimal places |
| [formatModelsDisplay](functions/formatModelsDisplay.md) | Formats an array of model names for display as a comma-separated string Removes duplicates and sorts alphabetically |
| [formatModelsDisplayMultiline](functions/formatModelsDisplayMultiline.md) | Formats an array of model names for display with each model on a new line Removes duplicates and sorts alphabetically |
| [pushBreakdownRows](functions/pushBreakdownRows.md) | Pushes model breakdown rows to a table |
| [createUsageReportTable](functions/createUsageReportTable.md) | Creates a standard usage report table with consistent styling and layout |
| [formatUsageDataRow](functions/formatUsageDataRow.md) | Formats usage data into a table row |
| [formatTotalsRow](functions/formatTotalsRow.md) | Creates a totals row with yellow highlighting |
| [addEmptySeparatorRow](functions/addEmptySeparatorRow.md) | Adds an empty separator row to the table for visual separation |

## Classes

| Class | Description |
| ------ | ------ |
| [ResponsiveTable](classes/ResponsiveTable.md) | Responsive table class that adapts column widths based on terminal size Automatically adjusts formatting and layout for different screen sizes |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [TableCellAlign](type-aliases/TableCellAlign.md) | Horizontal alignment options for table cells |
| [TableRow](type-aliases/TableRow.md) | Table row data type supporting strings, numbers, and formatted cell objects |
| [TableOptions](type-aliases/TableOptions.md) | Configuration options for creating responsive tables |
| [UsageReportConfig](type-aliases/UsageReportConfig.md) | Configuration options for creating usage report tables |
| [UsageData](type-aliases/UsageData.md) | Standard usage data structure for table rows |
