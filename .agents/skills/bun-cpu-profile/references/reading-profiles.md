# Reading Profiles

Read `*.cpuprofile.md` before opening the full JSON profile. Look for:

- Hot self-time frames in application code, not only total-time parents.
- Native frames such as `Map#set`, `JSON.parse`, `Intl.DateTimeFormat`, string
  slicing, array construction, stdout writes, and worker message serialization.
- Whether the hot frame is in parsing, merging, aggregation, rendering, or
  process startup.
- Whether worker-thread changes moved cost from parsing into post-worker merge.
- Whether an apparent hotspot matters to end-to-end hyperfine results.

Use `rg` on markdown profiles to connect frames to source:

```sh
rg -n "Map#set|JSON.parse|Intl|postMessage|write|data-loader|table" profiles/*.md
```

For `.cpuprofile`, open Chrome DevTools Performance tab or VS Code's CPU
profiler and inspect both bottom-up self time and call tree context.
