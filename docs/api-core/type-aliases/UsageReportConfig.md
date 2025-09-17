[@ccusage/core](../index.md) / UsageReportConfig

# Type Alias: UsageReportConfig

```ts
type UsageReportConfig = object;
```

Configuration options for creating usage report tables

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="firstcolumnname"></a> `firstColumnName` | `string` | Name for the first column (Date, Month, Week, Session, etc.) |
| <a id="includelastactivity"></a> `includeLastActivity?` | `boolean` | Whether to include Last Activity column (for session reports) |
| <a id="dateformatter"></a> `dateFormatter?` | (`dateStr`) => `string` | Date formatter function for responsive date formatting |
| <a id="forcecompact"></a> `forceCompact?` | `boolean` | Force compact mode regardless of terminal width |
