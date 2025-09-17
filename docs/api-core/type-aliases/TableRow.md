[@ccusage/core](../index.md) / TableRow

# Type Alias: TableRow

```ts
type TableRow = (
  | string
  | number
  | {
  content: string;
  hAlign?: TableCellAlign;
})[];
```

Table row data type supporting strings, numbers, and formatted cell objects
