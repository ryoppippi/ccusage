[@ccusage/core](../index.md) / TableOptions

# Type Alias: TableOptions

```ts
type TableOptions = object;
```

Configuration options for creating responsive tables

## Properties

| Property | Type |
| ------ | ------ |
| <a id="head"></a> `head` | `string`[] |
| <a id="colaligns"></a> `colAligns?` | [`TableCellAlign`](TableCellAlign.md)[] |
| <a id="style"></a> `style?` | `object` |
| `style.head?` | `string`[] |
| <a id="dateformatter"></a> `dateFormatter?` | (`dateStr`) => `string` |
| <a id="compacthead"></a> `compactHead?` | `string`[] |
| <a id="compactcolaligns"></a> `compactColAligns?` | [`TableCellAlign`](TableCellAlign.md)[] |
| <a id="compactthreshold"></a> `compactThreshold?` | `number` |
| <a id="forcecompact"></a> `forceCompact?` | `boolean` |
| <a id="logger"></a> `logger?` | (`message`) => `void` |
