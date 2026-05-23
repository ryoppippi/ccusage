{ pkgs }:
pkgs.writeShellApplication {
  name = "ccusage-hook-sync-skills";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.git
  ];
  text = ''
    check_mode=0
    if [ "''${1:-}" = "--check" ]; then
      check_mode=1
    fi

    repo_root=$(git rev-parse --show-toplevel)
    agents_dir="$repo_root/.agents/skills"
    target_dir="$repo_root/.claude/skills"
    label=".claude/skills"

    if [ "$check_mode" -eq 0 ]; then
      mkdir -p "$target_dir"
    fi

    declare -A expected_skills=()
    has_errors=0
    synced=0

    shopt -s nullglob
    for src in "$agents_dir"/*; do
      [ -d "$src" ] || continue

      name=$(basename "$src")
      expected_target="../../.agents/skills/$name"
      dst="$target_dir/$name"
      expected_skills["$name"]=1

      if [ "$check_mode" -eq 1 ]; then
        if [ ! -e "$dst" ] && [ ! -L "$dst" ]; then
          echo "Skill missing: $label/$name" >&2
          has_errors=1
          continue
        fi
        if [ ! -L "$dst" ]; then
          echo "Skill not a symlink: $label/$name" >&2
          has_errors=1
          continue
        fi
        if [ "$(readlink "$dst")" != "$expected_target" ]; then
          echo "Skill symlink incorrect: $label/$name" >&2
          has_errors=1
          continue
        fi
        synced=$((synced + 1))
        continue
      fi

      if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$expected_target" ]; then
        synced=$((synced + 1))
        continue
      fi

      rm -rf "$dst"
      ln -s "$expected_target" "$dst"
      synced=$((synced + 1))
    done

    for dst in "$target_dir"/*; do
      [ -e "$dst" ] || [ -L "$dst" ] || continue
      name=$(basename "$dst")
      if [ -z "''${expected_skills[$name]+x}" ]; then
        if [ "$check_mode" -eq 1 ]; then
          echo "Orphan skill: $label/$name" >&2
          has_errors=1
        else
          rm -rf "$dst"
          echo "Removed orphan skill: $label/$name"
        fi
      fi
    done

    if [ "$check_mode" -eq 1 ]; then
      if [ "$has_errors" -eq 1 ]; then
        echo "Skills are not in sync" >&2
        exit 1
      fi
      echo "Skills are in sync"
    else
      echo "Synced $synced skills: .agents/skills/ -> $label/ (symlinks)"
    fi
  '';
}
