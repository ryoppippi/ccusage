[@ccusage/core](../index.md) / ResponsiveTable

# Class: ResponsiveTable

Responsive table class that adapts column widths based on terminal size
Automatically adjusts formatting and layout for different screen sizes

## Constructors

### Constructor

```ts
new ResponsiveTable(options): ResponsiveTable;
```

Creates a new responsive table instance

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `options` | [`TableOptions`](../type-aliases/TableOptions.md) | Table configuration options |

#### Returns

`ResponsiveTable`

## Methods

### push()

```ts
push(row): void;
```

Adds a row to the table

#### Parameters

| Parameter | Type | Description |
| ------ | ------ | ------ |
| `row` | [`TableRow`](../type-aliases/TableRow.md) | Row data to add |

#### Returns

`void`

***

### isCompactMode()

```ts
isCompactMode(): boolean;
```

Returns whether the table is currently in compact mode

#### Returns

`boolean`

True if compact mode is active

***

### toString()

```ts
toString(): string;
```

Renders the table as a formatted string
Automatically adjusts layout based on terminal width

#### Returns

`string`

Formatted table string
