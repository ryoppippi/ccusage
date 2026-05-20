# Git Apply Flags

- `-v, --verbose`: always use this for detailed feedback during application.
- `--check`: verify whether a patch can be applied cleanly without making
  changes.
- `--cached`: stage the patch without applying it to the worktree.
- `--stat`: display affected files before applying.
- `--whitespace=fix`: automatically correct trailing whitespace issues.
- `--reject`: create `.rej` files for failed sections instead of aborting
  entirely.
- `--reverse` / `-R`: revert a previously applied patch.
