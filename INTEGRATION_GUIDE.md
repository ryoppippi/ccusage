# Upstream Integration Guide for better-ccusage

This guide helps manage integrations from the upstream ccusage project while preserving better-ccusage custom features.

## Key Integration Areas

### 1. **Pricing Database & Model Support**

Your custom additions:

- Zai provider support
- GLM-4.5 model integration
- Multi-provider cost calculation

**Conflict Risk:** HIGH - Upstream may add similar features or change pricing structure

**Strategy:**

- Backup your custom pricing configurations before integration
- Compare `pricing-data.ts` files carefully
- Test all your custom models after integration

### 2. **CLI Structure & Commands**

**Conflict Risk:** MEDIUM - Upstream may add new commands or change CLI structure

**Strategy:**

- Preserve your `--mode` flag for cost calculation
- Ensure your custom output formats remain functional
- Test all CLI commands after integration

### 3. **MCP Server Integration**

**Conflict Risk:** LOW-MEDIUM - Your MCP implementation is separate package

**Strategy:**

- Verify MCP tools still work after integration
- Check for any API changes in core functionality

### 4. **Dependencies & Build System**

**Conflict Risk:** MEDIUM - Upstream updates may conflict with your setup

**Strategy:**

- Review `package.json` changes carefully
- Test build process after integration
- Ensure your custom packages still work

## Integration Commands

### Quick Integration

```bash
# Use the automated script
./scripts/smart-integrate.sh

# Or manual process
git checkout -b smart-integrate
git merge upstream/main
# Resolve conflicts
git commit
```

### Before Integration

```bash
# Backup current state
git tag pre-integration-$(date +%Y%m%d)

# Check for potential conflicts
git diff --name-only upstream/main...HEAD | grep -E "(pricing|models|cli)"
```

### After Integration

```bash
# Test everything
pnpm typecheck
pnpm test
pnpm run build

# Test your custom features
pnpm run start daily --mode auto
pnpm run start session --json
```

## Conflict Resolution Strategies

### 1. **Pricing Data Conflicts**

```bash
# Your changes should take precedence
git checkout --ours apps/better-ccusage/pricing-data.ts
git add apps/better-ccusage/pricing-data.ts
```

### 2. **CLI Command Conflicts**

```bash
# Preserve your custom flags and modes
git checkout --ours apps/better-ccusage/src/commands/
git add apps/better-ccusage/src/commands/
```

### 3. **Dependency Conflicts**

```bash
# Usually take upstream's newer versions
git checkout --theirs package.json pnpm-lock.yaml
git add package.json pnpm-lock.yaml
```

## Testing Checklist

After each integration, verify:

- [ ] Zai provider support works
- [ ] GLM-4.5 models are recognized
- [ ] Multi-provider cost calculation accurate
- [ ] All CLI commands functional
- [ ] JSON output formats preserved
- [ ] MCP server operates correctly
- [ ] No regressions in existing features

## Automated Monitoring

The GitHub workflow in `.github/workflows/sync-upstream.yml` will:

- Check for upstream updates weekly
- Create integration branches automatically
- Open PRs for manual review
- Preserve your custom features

## Emergency Rollback

If integration breaks critical features:

```bash
git checkout main
git reset --hard pre-integration-YYYYMMDD
git push --force origin main
```
