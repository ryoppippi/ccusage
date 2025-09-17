[@ccusage/core](../index.md) / formatUsageDataRow

# Function: formatUsageDataRow()

```ts
function formatUsageDataRow(
   firstColumnValue, 
   data, 
   lastActivity?): (string | number)[];
```

Formats usage data into a table row

## Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `firstColumnValue` | `string` | Value for the first column |
| `data` | [`UsageData`](../type-aliases/UsageData.md) | Usage data to format |
| `lastActivity?` | `string` | Optional last activity string to append as final column |

## Returns

(`string` \| `number`)[]

Formatted table row
