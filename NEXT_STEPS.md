# DingTalk Channel - Next Steps & Priority Actions

**Status**: Development environment initialized, critical gaps identified.  
**Date**: Jan 27, 2026  
**Node Version**: v25.4.0

---

## 🎯 Executive Summary

The plugin is **technically functional** but **not production-ready** due to:

1. **Missing Type Definitions** - `clawdbot/plugin-sdk` not installed (blocks TS checking)
2. **ESLint Violations** - 500+ type safety violations from loose `any` types
3. **Test Execution Failure** - Vitest finds no test files (test.ts exists but not discovered)
4. **Missing Dependency** - `jiti` added to package.json but not installed

### Quick Stats
- **Type Errors**: 2 (missing module, unused variable)
- **ESLint Errors**: 500+
- **ESLint Warnings**: 50+
- **Test Files**: 1 (test.ts exists but vitest can't find it)
- **Dependencies**: Missing `clawdbot/plugin-sdk` and possibly `jiti`

---

## ⚡ Priority Action Items

### **PHASE 1: Fix Development Environment (TODAY)**

#### 1.1 Install `clawdbot/plugin-sdk` (BLOCKER)
```bash
npm install --save-dev clawdbot-sdk
# OR if the package name is different:
npm search clawdbot | grep sdk
```
**Why**: Required for TypeScript definitions. Unblocks `plugin.ts` type checking.  
**Verification**: `npm run type-check` should pass (except unused variable on line 337)

#### 1.2 Install missing `jiti` (already in package.json)
```bash
npm install  # Should pick up jiti from package.json
```
**Why**: Runtime TypeScript loader for Clawdbot plugin system.  
**Verification**: `node -e "require('jiti')"`  should not error

#### 1.3 Fix Vitest Test Discovery
**Problem**: Vitest doesn't find `test.ts` despite glob pattern  
**Solution**: 
- Rename `test.ts` → `plugin.test.ts`  
- OR update `vitest.config.ts` include pattern
- OR check if vitest needs TypeScript support enabled

```typescript
// vitest.config.ts option 1:
export default defineConfig({
  test: {
    include: ['**/*.test.ts', '**/*.spec.ts']
  }
});
```

**Verification**: `npm test` finds tests and runs them

#### 1.4 Fix Unused Variable Warning (line 337)
```typescript
// BEFORE:
export const stopAccount = (accountId: AccountDef, context: any) => {
  
// AFTER:
export const stopAccount = (_accountId: AccountDef, context: any) => {
```
**Why**: Meets ESLint rule: unused args must match `/^_/u`

---

### **PHASE 2: Type Safety Refactoring (WEEK 1)**

The plugin uses excessive `any` types (500+ violations). This is a **refactoring task**, not urgent, but blocks proper CI/CD.

#### 2.1 Create Type Definitions File
```bash
# Create src/types.ts
touch src/types.ts
```

**Content** (minimal):
```typescript
import type { PluginContext, Message, ChannelConfig } from 'clawdbot/plugin-sdk';

export interface DingTalkConfig extends ChannelConfig {
  clientId: string;
  clientSecret: string;
  robotCode: string;
  debug?: boolean;
}

export interface DingTalkMessage extends Message {
  msgId: string;
  createAt: number;
  conversationType: 'private' | 'group';
}
```

#### 2.2 Replace `any` types in plugin.ts
Use TypeScript strict mode. Key replacements:
- `any` → `DingTalkConfig`
- `any` → `Record<string, unknown>`
- `any` → `DingTalkMessage`

**Effort**: ~2-3 hours. High impact on maintainability.

#### 2.3 Update ESLint Rules (Optional)
Current `.eslintrc.json` is too strict for legacy code. Options:
- **Option A** (Recommended): Fix types (above)
- **Option B**: Relax rules temporarily:
  ```json
  {
    "@typescript-eslint/no-explicit-any": "warn",  // was error
    "@typescript-eslint/no-unsafe-*": "warn"       // was error
  }
  ```

---

### **PHASE 3: Testing & CI/CD Integration (WEEK 2)**

#### 3.1 Fix Integration Test (`test.js`)
Currently: Requires live DingTalk credentials at `~/.config/dingtalk/credentials.json`

**Options**:
- **A** (Simple): Make credentials optional, skip test if missing
- **B** (Better): Mock `dingtalk-stream` for offline testing
- **C** (Best): Use environment variables for CI testing

**Recommendation**: Start with Option A.

```javascript
// test.js - Add graceful skip:
const credPath = path.expandUser('~/.config/dingtalk/credentials.json');
if (!fs.existsSync(credPath)) {
  console.log('⚠️  Credentials not found at ~/.config/dingtalk/credentials.json');
  console.log('Skipping integration test. To enable:');
  console.log('  1. Create credentials file');
  console.log('  2. Run: node test.js');
  process.exit(0);
}
```

#### 3.2 Implement Mocked Unit Tests
Use librarian agent findings. Example pattern:

```typescript
// plugin.test.ts
import { vi, describe, it, expect } from 'vitest';
import { DWClient } from 'dingtalk-stream';

vi.mock('dingtalk-stream', () => ({
  DWClient: vi.fn().mockImplementation(() => ({
    registerCallbackListener: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('DingTalk Plugin', () => {
  it('should initialize with config', () => {
    // Test implementation here
  });
});
```

#### 3.3 Verify CI/CD Works
```bash
# Simulate CI environment
npm ci
npm run type-check
npm run lint
npm test
```

**Current Status**: Will fail until Phase 1 complete.

---

### **PHASE 4: Documentation & Onboarding (OPTIONAL)**

#### 4.1 Add "Dev Quickstart" to AGENT.md
```markdown
## Developer Quickstart

### First Time Setup
1. Clone repo & install dependencies
2. Run `npm install` to populate node_modules
3. Create credentials file (see Configuration)
4. Run tests: `npm test`

### Common Commands
- `npm run check` - Type check + lint
- `npm run lint:fix` - Auto-fix formatting
- `npm test` - Run unit tests
```

#### 4.2 Create CONTRIBUTING.md
- Commit message standards
- PR process
- Testing requirements

---

## 🔍 Detailed Findings

### Type System Issues

| Issue | Location | Fix | Effort |
|-------|----------|-----|--------|
| Missing module | plugin.ts:12 | Install clawdbot/plugin-sdk | 2 min |
| Unused variable | plugin.ts:337 | Prefix with `_` | 1 min |
| 500+ `any` types | plugin.ts | Type refactoring | 2-3 hrs |

### Test Framework Issues

| Issue | Current | Expected | Fix |
|-------|---------|----------|-----|
| Test discovery | No files found | Find test.ts | Rename or update config |
| Mock data | None | Mock DWClient | Implement mocks |
| Coverage | N/A | >80% target | Add test cases |

### Linting Issues

**Top 10 ESLint Errors** (by frequency):
1. `no-unsafe-member-access` (200+ instances)
2. `no-unsafe-assignment` (120+ instances)
3. `no-unsafe-call` (80+ instances)
4. `no-unsafe-argument` (20+ instances)
5. `no-explicit-any` (50+ warnings)

**Root Cause**: All from loose typing (missing `clawdbot/plugin-sdk` types)

---

## 📊 Project Health Assessment

| Dimension | Status | Notes |
|-----------|--------|-------|
| **Functionality** | ✅ Works | No runtime errors observed |
| **Type Safety** | ⚠️ Warning | Missing type definitions |
| **Code Quality** | ⚠️ Warning | ESLint violations unfixed |
| **Testing** | ❌ Broken | Vitest can't find tests |
| **CI/CD** | ⚠️ Warning | Tests will fail until fixed |
| **Documentation** | ✅ Good | AGENT.md is comprehensive |

**Overall**: **Pre-Alpha** → **Alpha Ready** with Phase 1 fixes

---

## 🚀 Recommended Execution Order

### Week 1 (Phase 1 - Development Environment)
- **Monday**: Install missing packages, fix test discovery
- **Tuesday**: Verify all quality checks pass
- **Wednesday**: Fix unused variable warning

### Week 2 (Phase 2 - Type Safety)
- **Thursday-Friday**: Create types.ts, refactor 50% of plugin.ts
- **Following Week**: Complete remaining type refactoring

### Week 3 (Phase 3 - Testing)
- Implement mocked tests
- Verify CI/CD pipeline works

### Optional (Phase 4 - Documentation)
- Add developer onboarding guides
- Create CONTRIBUTING.md

---

## 📋 Verification Checklist

- [ ] `npm install` completes without errors
- [ ] `npm run type-check` passes
- [ ] `npm run lint` shows <10 errors
- [ ] `npm test` finds and runs tests
- [ ] `npm run check` (all checks) passes
- [ ] Git commit passes pre-commit hooks
- [ ] CI/CD workflow succeeds on GitHub

---

## 🔗 References

- **Librarian Findings**: jiti, Vitest, DingTalk Stream mocking patterns
- **Explorer Findings**: Integration test expectations, dev tool requirements
- **AGENT.md**: 552-line comprehensive architecture guide
- **Plugin SDK**: Clawdbot plugin interface requirements

---

## 💡 Key Insights

### Why This Happened
The plugin was created quickly (commit history shows) without:
- Type definitions installed (`clawdbot/plugin-sdk` missing)
- Proper ESLint configuration locked down
- Test infrastructure properly configured

### Why It Matters
- **Type Safety**: Catches bugs at compile time
- **Code Quality**: ESLint catches common errors
- **Testability**: Unit tests prevent regressions
- **Maintainability**: Future developers need confidence

### Why It's Fixable
- No architectural issues (all issues are configuration)
- Clear path to enterprise-grade standards
- All tools are installed and working
- Code logic is sound (just needs type annotations)

---

## Next Session Continuation

If resuming later, run:
```bash
cd /Users/sym/clawd/extensions/dingtalk-channel

# Check current status
npm run type-check    # Should show: 2 errors (missing module + unused var)
npm run lint          # Should show: 500+ errors (all from loose typing)
npm test              # Should show: No test files found

# After installing clawdbot/plugin-sdk:
npm run type-check    # Should show: 1 error (unused variable)
npm run lint          # Should show: <50 errors (related to unused var + any types)
```

---

**Last Updated**: Jan 27, 2026, 14:52 UTC+8  
**Status**: 🟡 READY FOR PHASE 1 EXECUTION
