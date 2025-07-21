# Performance Optimizations

This document describes the performance optimizations implemented in ccusage and their trade-offs.

## File Filtering Optimization (v15.6.0)

### Overview

When using the `--since` flag, ccusage now pre-filters files based on their modification time before reading their contents. This optimization provides up to 10x performance improvement when loading usage data.

### Performance Impact

- **Before**: ~10 seconds to load data with `--since` flag
- **After**: ~1 second to load data with `--since` flag
- **Improvement**: Up to 10x faster

### Implementation Details

#### 1. Modification Time Pre-filtering

Located in `src/data-loader.ts`:

```typescript
// Pre-filter files based on modification time
const fileStats = await Promise.all(
  projectFilteredFiles.map(async file => ({
    file,
    mtime: await stat(file).then(s => s.mtime).catch(() => null)
  }))
);
timeFilteredFiles = fileStats
  .filter(({ mtime }) => mtime != null && mtime >= sinceDate)
  .map(({ file }) => file);
```

**How it works:**
- Before reading any file contents, check each file's modification time (mtime)
- Skip files with mtime older than the `--since` date
- Only read and parse files that were modified after the specified date

**Why this is safe:**
- Claude Code always appends new data (never modifies existing entries)
- When new data is appended, the file's mtime is automatically updated
- Therefore: if mtime < since date, the file cannot contain data after that date

#### 2. Streaming File Reader

Located in `src/data-loader.ts` in the `getEarliestTimestamp` function:

```typescript
// Stream file and read only first few lines
const lineProcessor = new Transform({
  transform(chunk, encoding, callback) {
    // Process lines and stop after finding timestamp
    if (linesRead >= MAX_LINES) {
      this.push(null);
      return callback();
    }
    // ... process lines
  }
});
```

**How it works:**
- Uses Node.js streams to read files line by line
- Stops reading after finding a timestamp (usually in the first line)
- Prevents loading entire files into memory

### Why This Optimization Is Safe

#### Claude Code's Append-Only Architecture

1. **Data is Never Modified**
   - Claude Code only appends new usage data
   - Existing entries are never changed or deleted
   - Each append operation updates the file's mtime

2. **mtime Reliability**
   - Modern file systems always update mtime on write
   - Even file restoration typically preserves or updates mtime
   - mtime cannot be older than the last data written to the file

#### Theoretical Edge Case

The only scenario where this optimization could miss data:
- Claude appends new data but mtime is not updated
- This would require a file system bug or Claude bug
- Has never been observed in practice

### Testing the Optimization

To test the performance improvement:

```bash
# Before optimization (using main branch)
time npx github:ryoppippi/ccusage daily --since 20250715

# After optimization (using this branch)
time npx github:mbailey/ccusage#performance-optimization daily --since 20250715
```

The difference should be immediately noticeable for users with significant usage history.

### Future Improvements

1. **Add `--strict` Flag**
   ```bash
   ccusage daily --since 20250715 --strict
   ```
   - Disable mtime optimization
   - Read all files regardless of modification time
   - Provides a safety valve if issues ever arise

2. **Debug Logging**
   - Add optional logging to show which files were skipped
   - Help diagnose any unexpected behavior

### Conclusion

This optimization significantly improves the user experience for the most common use case (recent data analysis) while maintaining correctness. The theoretical edge case where data could be missed would require a fundamental bug in either the file system or Claude Code itself, making this optimization safe for production use.