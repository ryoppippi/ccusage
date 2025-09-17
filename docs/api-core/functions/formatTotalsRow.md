[@ccusage/core](../index.md) / formatTotalsRow

# Function: formatTotalsRow()

```ts
function formatTotalsRow(totals, includeLastActivity): (string | number)[];
```

Creates a totals row with yellow highlighting

## Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `totals` | [`UsageData`](../type-aliases/UsageData.md) | `undefined` | Totals data to display |
| `includeLastActivity` | `boolean` | `false` | Whether to include an empty last activity column |

## Returns

(`string` \| `number`)[]

Formatted totals row
