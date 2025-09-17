[@ccusage/core](../index.md) / pushBreakdownRows

# Function: pushBreakdownRows()

```ts
function pushBreakdownRows(
   table, 
   breakdowns, 
   extraColumns, 
   trailingColumns): void;
```

Pushes model breakdown rows to a table

## Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `table` | \{ `push`: (`row`) => `void`; \} | `undefined` | The table to push rows to |
| `table.push` | (`row`) => `void` | `undefined` | - |
| `breakdowns` | `object`[] | `undefined` | Array of model breakdowns |
| `extraColumns` | `number` | `1` | Number of extra empty columns before the data (default: 1 for models column) |
| `trailingColumns` | `number` | `0` | Number of extra empty columns after the data (default: 0) |

## Returns

`void`
