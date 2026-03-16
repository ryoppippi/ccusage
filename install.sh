#!/usr/bin/env bash
set -e

REPO="https://github.com/r1di/ccusage.git"
BRANCH="feat/statusline-improvements"
DIR="$HOME/.ccusage-fork"
PKG="$DIR/apps/ccusage"
DIST="$PKG/dist/index.js"

echo "ccusage statusline installer (r1di fork)"

for cmd in node git; do
    command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: $cmd not found."; exit 1; }
done

if ! command -v pnpm >/dev/null 2>&1; then
    echo "Installing pnpm..."
    npm install -g pnpm --loglevel=error
fi

if [ -d "$DIR/.git" ]; then
    echo "Updating repo..."
    git -C "$DIR" fetch origin
    git -C "$DIR" checkout "$BRANCH"
    git -C "$DIR" reset --hard "origin/$BRANCH"
else
    echo "Cloning repo..."
    git clone --branch "$BRANCH" --depth 1 "$REPO" "$DIR"
fi

echo "Building..."
cd "$PKG"
pnpm install --frozen-lockfile=false
pnpm run build

echo "Configuring Claude Code settings.json..."
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"

node - "$SETTINGS" "$DIST" <<'EOF'
const fs = require('fs')
const p = process.argv[2], dist = process.argv[3]
let s = {}
try { s = JSON.parse(fs.readFileSync(p, 'utf8')) } catch {}
s.statusLine = { type: 'command', command: `node "${dist}" statusline` }
fs.writeFileSync(p, JSON.stringify(s, null, 2))
EOF

echo "Done. Restart Claude Code to activate the statusline."
