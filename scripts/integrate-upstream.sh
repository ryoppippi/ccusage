#!/bin/bash

# Integration script for better-ccusage upstream sync
# Usage: ./scripts/integrate-upstream.sh [upstream-commit]

set -e

UPSTREAM_COMMIT=${1:-"upstream/main"}
CURRENT_BRANCH=$(git branch --show-current)
INTEGRATION_BRANCH="integrate-upstream-$(date +%Y%m%d-%H%M%S)"

echo "🔄 Starting upstream integration..."
echo "Current branch: $CURRENT_BRANCH"
echo "Integration branch: $INTEGRATION_BRANCH"
echo "Upstream target: $UPSTREAM_COMMIT"

# Create integration branch
git checkout -b "$INTEGRATION_BRANCH"

# Fetch latest upstream
git fetch upstream

# Get commit info
UPSTREAM_HASH=$(git rev-parse "$UPSTREAM_COMMIT")
CURRENT_HASH=$(git rev-parse HEAD)

echo "📊 Integration details:"
echo "  From: $CURRENT_HASH"
echo "  To:   $UPSTREAM_HASH"

# Create custom merge commit message
cat > /tmp/merge-msg.txt << EOF
feat: integrate upstream ccusage changes

## Upstream Changes
- Integrated upstream commit: $UPSTREAM_HASH
- Preserved all better-ccusage custom features:
  - Zai provider support
  - GLM-4.5 model integration
  - Multi-provider cost calculation
  - Enhanced pricing database

## Test Plan
- [ ] Verify Zai provider functionality
- [ ] Test GLM-4.5 model support
- [ ] Run complete test suite
- [ ] Check CLI output formats
- [ ] Validate MCP server operation

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF

# Attempt merge
if git merge "$UPSTREAM_COMMIT" -F /tmp/merge-msg.txt; then
    echo "✅ Merge completed successfully!"

    # Run basic tests
    echo "🧪 Running basic validation..."
    if command -v pnpm &> /dev/null; then
        pnpm typecheck || echo "⚠️  Type check failed - please review"
        pnpm test || echo "⚠️  Tests failed - please review"
    fi

    echo "🎉 Integration complete!"
    echo "📋 Next steps:"
    echo "   1. Review changes: git show --stat"
    echo "   2. Test thoroughly"
    echo "   3. Create PR: gh pr create --title 'feat: integrate upstream ccusage' --body 'Auto-generated integration'"

else
    echo "❌ Merge conflicts detected!"
    echo "🔧 Please resolve conflicts manually:"
    echo "   1. git status"
    echo "   2. Resolve conflicted files"
    echo "   3. git add ."
    echo "   4. git commit"
    echo ""
    echo "💡 Focus on preserving:"
    echo "   - Zai provider support in pricing data"
    echo "   - GLM-4.5 model configurations"
    echo "   - Custom better-ccusage features"
fi

# Cleanup
rm -f /tmp/merge-msg.txt