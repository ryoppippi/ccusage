# Building and Installing ccusage Locally

This guide explains how to build and install a custom version of ccusage for local development and testing.

## Prerequisites

- [Bun](https://bun.sh/) runtime (latest version)
- Node.js (for global installation via npm)
- Git (for version control)

## Quick Start

```bash
# 1. Clone and navigate to the project
git clone <your-fork-url>
cd ccusage

# 2. Install dependencies
bun install

# 3. Build the project
bun run build

# 4. Install globally with custom name
npm install -g .
```

## Building Options

### Option 1: Development Link (Recommended for Active Development)

Use this when actively developing and want changes to be immediately available:

```bash
# Link for development (changes reflect immediately)
bun link

# Use the original command name
ccusage blocks --help

# Unlink when done
bun unlink
```

**Pros:**

- ✅ No build step needed
- ✅ Changes reflect immediately
- ✅ Easy to remove

**Cons:**

- ❌ Uses development code (not production build)
- ❌ Requires project directory to remain intact

### Option 2: Custom Named Global Install (Recommended for Testing)

Use this when you want a separate command alongside the official ccusage:

```bash
# 1. Modify package.json name field
# Change "name": "ccusage" to "name": "your-custom-name"

# 2. Build the project
bun run build

# 3. Install globally
npm install -g .

# 4. Use your custom command
your-custom-name blocks --help
```

**Pros:**

- ✅ Separate from official ccusage
- ✅ Production build
- ✅ Works from any directory

**Cons:**

- ❌ Requires rebuild for changes
- ❌ Need to manage package name

### Option 3: Shell Alias (Simplest)

Use this for quick testing without global installation:

```bash
# Add to ~/.bashrc or ~/.zshrc
alias ccusage-local='bun --cwd /path/to/your/ccusage run start'

# Reload shell
source ~/.zshrc

# Use the alias
ccusage-local blocks --help
```

## Custom Package Name Setup

### Step 1: Modify Package Name

Edit `package.json`:

```json
{
	"name": "your-custom-name",
	"version": "15.2.0"
	// ... rest of configuration
}
```

Common naming patterns:

- `ccusage-dev` - for development version
- `ccusage-local` - for local testing
- `hg-ccusage` - with your initials
- `ccusage-fork` - for forked version

### Step 2: Build and Install

```bash
# Clean any previous builds
rm -rf dist/

# Build the project
bun run build

# Install globally
npm install -g .
```

### Step 3: Verify Installation

```bash
# Check version
your-custom-name --version

# Test functionality
your-custom-name blocks --help

# Test new cost limit feature
your-custom-name blocks --live --cost-limit max
```

## Build Scripts

The project includes these build-related scripts:

```bash
# Core build commands
bun run build          # Build distribution files
bun run typecheck       # Type check TypeScript
bun run format          # Format and lint code
bun run test            # Run test suite

# Quality assurance
bun run release         # Full release workflow (lint + typecheck + test + build)

# Development
bun run start           # Run from source
```

## Troubleshooting

### Build Fails

```bash
# Clean and rebuild
rm -rf dist/ node_modules/
bun install
bun run build
```

### Global Install Fails

```bash
# Try with npm instead of bun
npm install -g .

# Or try with sudo (macOS/Linux)
sudo npm install -g .
```

### Command Not Found

```bash
# Check if it's in your PATH
which your-custom-name

# Check npm global packages
npm list -g --depth=0

# Verify npm global bin directory
npm config get prefix
```

### Permission Issues

```bash
# Fix npm permissions (macOS/Linux)
mkdir ~/.npm-global
npm config set prefix '~/.npm-global'

# Add to ~/.bashrc or ~/.zshrc
export PATH=~/.npm-global/bin:$PATH
```

## Uninstalling

### Remove Global Package

```bash
# Remove globally installed package
npm uninstall -g your-custom-name

# Or if using original name
npm uninstall -g ccusage
```

### Remove Development Link

```bash
# In project directory
bun unlink
```

### Remove Shell Alias

```bash
# Edit ~/.bashrc or ~/.zshrc and remove the alias line
# Then reload shell
source ~/.zshrc
```

## Development Workflow

### For Active Development

```bash
# 1. Use development link
bun link

# 2. Make changes to source files
# 3. Test immediately (no rebuild needed)
ccusage blocks --live --cost-limit max

# 4. When satisfied, create production build
bun unlink
bun run build
npm install -g .
```

### For Testing Builds

```bash
# 1. Make changes
# 2. Build and install
bun run build && npm install -g .

# 3. Test
your-custom-name blocks --help

# 4. Iterate
```

## New Features Added

This build includes the new cost-based live monitoring feature:

```bash
# Cost limit with numeric value
your-custom-name blocks --live --cost-limit 10.0

# Cost limit with max from previous sessions
your-custom-name blocks --live --cost-limit max

# Mutual exclusivity validation (shows error)
your-custom-name blocks --live --token-limit 1000 --cost-limit 5.0
```

## Contributing Back

When ready to contribute your changes:

```bash
# 1. Ensure tests pass
bun run test

# 2. Format code
bun run format

# 3. Type check
bun typecheck

# 4. Create commit
git add .
git commit -m "feat: add cost-based live monitoring"

# 5. Push and create PR
git push origin your-branch-name
```

## Notes

- Always test both development and production builds
- Keep the original ccusage functionality intact
- Document any breaking changes
- Consider backwards compatibility
- Test on different terminal sizes for live monitoring
