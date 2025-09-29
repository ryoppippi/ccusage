# Manual Integration Guide for better-ccusage (WSL Required)

## Current Situation

### WSL Environment Required
This monorepo requires WSL for proper development and integration. Windows has path and binary compatibility issues with Node.js monorepos.

**Quick Start in WSL:**
```bash
# Navigate to your project in WSL
cd /mnt/d/Dev/better-ccusage

# Install dependencies
pnpm install

# Run tests
pnpm test
```

### Repository Structure Differences
- **Your repo**: `apps/better-ccusage/` (with Zai/GLM-4.5 custom features)
- **Upstream**: `apps/ccusage/` (original ccusage)

This makes automated merging complex. Here's the safest manual approach:

## Recommended Integration Process

### 1. Check what's new in upstream (in WSL)
```bash
# See recent upstream changes
git log --oneline upstream/main -10

# See what files changed since your last integration
git diff --name-only upstream/main...HEAD
```

### 2. Manual cherry-pick of specific features
Instead of merging everything, pick the changes you want:

```bash
# Create integration branch
git checkout -b integrate-upstream-features

# Get the list of commits since your fork point
git log --oneline upstream/main --since="2024-01-01" | head -20
```

### 3. Test in WSL before integration
```bash
# Always test in WSL first
cd /mnt/d/Dev/better-ccusage
pnpm test
pnpm typecheck
```

### 4. Focus on high-value changes
Look for these types of changes in upstream:
- Bug fixes
- Performance improvements
- New CLI features
- Updated dependencies

### 5. Manual file comparison
For important files, compare manually:

```bash
# Compare specific files
git diff upstream/main:apps/ccusage/src/commands/daily.ts apps/better-ccusage/src/commands/daily.ts

# Compare pricing data (carefully - you have custom additions)
git diff upstream/main:apps/ccusage/model_prices_and_context_window.json apps/better-ccusage/model_prices_and_context_window.json
```

### 6. Apply changes selectively
Copy improvements from upstream to your `apps/better-ccusage/` directory, preserving:
- Your Zai provider support
- GLM-4.5 model pricing
- Multi-provider cost calculation
- Your package structure

## Integration Checklist (in WSL)

After applying upstream changes, verify:

- [ ] All CLI commands still work: `pnpm run start daily`
- [ ] Zai provider functionality preserved
- [ ] GLM-4.5 models still recognized
- [ ] Custom pricing data intact
- [ ] MCP server operational: `pnpm dlx @better-ccusage/mcp@latest -- --help`
- [ ] Test suite passes: `pnpm test`
- [ ] Type checking passes: `pnpm typecheck`
- [ ] Build succeeds: `pnpm build`

## WSL Development Setup

If you haven't set up WSL for this project:

```bash
# Install WSL (Ubuntu recommended)
wsl --install

# Once installed, navigate to your project
cd /mnt/d/Dev/better-ccusage

# Ensure Node.js and pnpm are installed in WSL
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
npm install -g pnpm

# Install dependencies
pnpm install
```

## Automated Monitoring Setup

The GitHub workflow will still notify you of upstream changes, but manual integration is safer given your structural differences.

## Alternative: Fork Strategy

If you want easier integrations in the future, consider:

1. Keep upstream structure (`apps/ccusage/`)
2. Add your features as extensions rather than restructuring
3. Use configuration files to enable/disable your custom features

This would make future merges much cleaner.