# Git Apply Troubleshooting

Trailing whitespace:

```bash
git apply --check --whitespace=fix patch_file.patch
git apply --whitespace=fix -v patch_file.patch
```

Partial failures:

```bash
git apply --reject -v patch_file.patch
```

Context mismatch:

```bash
git apply --ignore-whitespace -v patch_file.patch
```

Line ending issues:

```bash
git apply --ignore-space-change -v patch_file.patch
```
