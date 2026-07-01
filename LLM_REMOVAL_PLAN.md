# LLM Removal Plan - FTDC Analyzer

**Date**: 2026-07-01  
**Objective**: Remove all LLM dependencies from codebase while maintaining assessment functionality

---

## Impact Analysis

### Files Requiring Changes (12 files)

**Backend (Rust):**
1. ✅ `app/src-tauri/src/llm.rs` - **DELETE ENTIRE FILE** (636 lines)
2. ✅ `app/src-tauri/src/lib.rs` - Remove llm module import and Tauri commands

**Frontend (TypeScript/React):**
3. ✅ `app/src/lib/llm.ts` - **DELETE ENTIRE FILE** (174 lines)
4. ✅ `app/src/lib/narration.ts` - Replace with template-based engine
5. ✅ `app/src/components/LlmSettings.tsx` - **DELETE ENTIRE FILE**
6. ✅ `app/src/components/AssessmentControls.tsx` - Remove LLM mode and ModelPicker
7. ✅ `app/src/components/AssessmentV2Panel.tsx` - Remove LLM-specific rendering
8. ✅ `app/src/components/AssessmentPanel.tsx` - Remove LLM references
9. ✅ `app/src/components/Landing.tsx` - Remove LLM mode selector
10. ✅ `app/src/App.tsx` - Remove LlmSettings import and modal

**Python Engine:**
11. ✅ `ftdc_analyzer/scorer.py` - Remove `llm_narration` field from assessment_v2
12. ✅ `app/src/lib/ruleset.ts` - Remove `llm_narration` type definition

### Hardcoded Endpoint Removal
- ❌ **`https://ai.ocialwaysfree.site`** (4 occurrences in `llm.rs`) - WILL BE DELETED

---

## Testing Strategy

### Phase 1: Pre-Change Testing (Baseline)
```bash
# 1. Test current build
cd /Users/manishsinha/Desktop/projects/ftdc-analyzer
make clean
make sidecar  # Build Python engine
npm ci        # Install frontend deps
cd app && npm run dev  # Test UI loads

# 2. Verify current functionality
# - Load sample FTDC data
# - Generate assessment (both modes)
# - Export report
# - Check console for errors
```

### Phase 2: Unit Testing During Changes
- After each file modification, verify TypeScript compiles
- Check Rust builds successfully
- Ensure Python engine still outputs valid JSON

### Phase 3: Integration Testing (Post-Change)
```bash
# 1. Build sidecar
make sidecar

# 2. Test CLI mode (no UI dependencies)
.venv/bin/python -m ftdc_analyzer.cli ./files/ludo-prod-mongo-03/diagnostic.data --stdout | jq '.assessment_v2'

# 3. Build and run full app
make dev

# 4. Smoke tests in UI:
#    - Open FTDC data
#    - Generate assessment (template mode only)
#    - Verify all tabs load (System, Charts, Signals, Assessment)
#    - Check assessment narrative renders
#    - Export HTML report
#    - Verify no console errors
```

### Phase 4: End-to-End Testing
- Full analysis workflow with healthcheck + FTDC
- Test all assessment intents (right-sizing, cost-opt, RCA, etc.)
- Verify sizing recommendations still work
- Test report export (HTML + JSON)
- Verify no broken references in UI

---

## Implementation Plan

### Step 1: Implement Template-Based Narrative Engine ⏱️ ~30 min

**File**: `app/src/lib/narration.ts`

**Current**: LLM-based narration with HTTP calls  
**New**: Pure TypeScript template generator

**Changes**:
```typescript
// Remove all LLM client code
// Keep interface: runNarration() returns NarrationResult
// Implement template-based generation from assessment_v2 data
```

**Key Functions**:
- `generateTemplateNarrative(v2, focusId, sizing)` - Main generator
- `generateFindingsSection(fired)` - "What we found"
- `generateReasoningSection(dominant)` - "Why it points here"
- `generateCaveatsSection(caveats)` - "What would change this"

**Test**: Function produces well-formatted narrative from sample assessment JSON

---

### Step 2: Remove LLM UI Components ⏱️ ~20 min

#### 2a. Delete `app/src/components/LlmSettings.tsx`
- Entire file removed
- Remove from App.tsx imports

#### 2b. Update `app/src/components/AssessmentControls.tsx`
- Remove `AssessmentMode` "llm" option (keep only "grounded")
- Delete `ModeSelector` component entirely
- Delete `ModelPicker` component entirely
- Remove all LLM imports (`getLlmConfig`, `setLlmConfig`, etc.)
- Update `IntentPicker` and `CategorySelector` to remain functional

**Before**:
```typescript
export type AssessmentMode = "grounded" | "llm";
```

**After**:
```typescript
// No mode selection needed - always grounded
```

#### 2c. Update `app/src/components/AssessmentV2Panel.tsx`
- Remove mode state and mode selector
- Remove narration loading/error states
- Always show deterministic assessment
- Remove `runNarration()` calls
- Show template-generated narrative directly

#### 2d. Update `app/src/components/Landing.tsx`
- Remove LLM mode radio button
- Remove model picker from wizard
- Simplify pre-flight to just: Intent + Inputs + Cloud selection

#### 2e. Update `app/src/App.tsx`
- Remove `LlmSettings` import
- Remove `llmOpen` state
- Remove `<LlmSettings>` modal components

**Test After Each**: TypeScript compiles, dev server runs

---

### Step 3: Remove Rust LLM Backend ⏱️ ~15 min

#### 3a. Delete `app/src-tauri/src/llm.rs`
- Entire file (636 lines) removed
- This eliminates `ocialwaysfree.site` hardcoded endpoint

#### 3b. Update `app/src-tauri/src/lib.rs`
```rust
// Remove: mod llm;
// Remove from tauri::Builder:
//   llm::llm_list_models,
//   llm::llm_chat,
//   llm::llm_get_config,
//   llm::llm_set_config,
```

**Test**: `cargo build --release` in `app/src-tauri` succeeds

---

### Step 4: Delete Frontend LLM Library ⏱️ ~5 min

#### 4a. Delete `app/src/lib/llm.ts`
- Entire file (174 lines) removed
- Contains provider config, client, model labeling

**Test**: No import errors in remaining files

---

### Step 5: Update Type Definitions ⏱️ ~10 min

#### 5a. Update `app/src/lib/ruleset.ts`
```typescript
// Remove from AssessmentV2 interface:
// llm_narration: string | null;
```

#### 5b. Update Python engine `ftdc_analyzer/scorer.py`
```python
# Remove from score() return dict:
# "llm_narration": None,
```

**Test**: Python engine outputs valid JSON without llm_narration field

---

### Step 6: Clean Up Imports ⏱️ ~10 min

Run cleanup pass to remove orphaned imports:
```bash
# Check for remaining llm imports
cd app/src
grep -r "from.*llm" --include="*.tsx" --include="*.ts"
grep -r "import.*llm" --include="*.tsx" --include="*.ts"
```

Fix any remaining references in:
- `AssessmentPanel.tsx`
- Any other files that imported but didn't use

---

## Smoke Test Checklist

### Pre-Flight (Before Changes)
- [ ] Current app builds: `make app` succeeds
- [ ] Current app runs: `open app/src-tauri/target/release/bundle/dmg/*.dmg`
- [ ] Can load FTDC data
- [ ] Can generate grounded assessment
- [ ] Can generate LLM assessment (should work now, will be removed)

### Post-Implementation (After All Changes)
- [ ] TypeScript compiles: `cd app && npm run build`
- [ ] Rust compiles: `cd app/src-tauri && cargo build --release`
- [ ] Python sidecar builds: `make sidecar`
- [ ] Full app builds: `make app`
- [ ] Dev server runs: `make dev`

### Functional Testing
- [ ] Landing screen loads without errors
- [ ] Can select FTDC file
- [ ] Can select healthcheck file
- [ ] Pre-flight wizard shows only grounded mode
- [ ] Analyze button works
- [ ] Assessment tab displays results
- [ ] Template narrative is generated and displayed
- [ ] All 3 narrative sections present:
  - [ ] "What we found"
  - [ ] "Why it points here"
  - [ ] "What would change this"
- [ ] Evidence ledgers expand/collapse
- [ ] Sizing panel displays recommendations
- [ ] Charts tab displays metrics
- [ ] System tab shows host info
- [ ] Signals tab shows metrics table
- [ ] Export HTML report works
- [ ] Exported report contains narrative

### Console/Error Checking
- [ ] No TypeScript errors in dev console
- [ ] No React errors/warnings
- [ ] No Rust/Tauri errors in terminal
- [ ] No Python engine errors in logs
- [ ] No 404s for missing endpoints
- [ ] No "llm" or "LLM" strings in console output

### Edge Cases
- [ ] FTDC-only analysis (no healthcheck)
- [ ] Healthcheck-only analysis (no FTDC)
- [ ] Combined FTDC + healthcheck analysis
- [ ] All intent types (right-sizing, cost-opt, RCA, etc.)
- [ ] Category focus mode (single category deep-dive)
- [ ] Multiple FTDC files in directory

---

## Rollback Plan

If critical issues found:
1. **Git**: All changes tracked in git - can revert via `git reset --hard HEAD~1`
2. **Backup**: Create backup branch before starting: `git checkout -b backup-before-llm-removal`
3. **Partial rollback**: If template engine has issues, can temporarily restore LLM files while fixing

---

## Success Criteria

✅ **Build succeeds**: `make app` completes without errors  
✅ **No LLM references**: Zero occurrences of `ocialwaysfree.site` in codebase  
✅ **No LLM imports**: No imports from deleted `llm.ts` or `llm.rs`  
✅ **Assessment works**: Template-based narrative displays correctly  
✅ **All UI functional**: System/Charts/Signals/Assessment tabs load  
✅ **Reports export**: HTML and JSON exports contain proper narratives  
✅ **No console errors**: Clean browser console and terminal output  

---

## Estimated Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Template Engine Implementation | 30 min | None |
| UI Component Removal | 20 min | Template engine ready |
| Rust Backend Cleanup | 15 min | UI changes complete |
| Type Definition Updates | 10 min | Rust changes complete |
| Import Cleanup | 10 min | All above complete |
| Smoke Testing | 30 min | All changes complete |
| E2E Testing | 20 min | Smoke tests pass |
| **Total** | **~2.5 hours** | Sequential execution |

---

## Files to Delete (Summary)

1. `app/src-tauri/src/llm.rs` (636 lines)
2. `app/src/lib/llm.ts` (174 lines)
3. `app/src/components/LlmSettings.tsx` (entire file)

**Total lines deleted**: ~1,200+ lines  
**Hardcoded endpoints removed**: 4 occurrences of `ocialwaysfree.site`

---

*Plan created: 2026-07-01*
*Ready for execution: YES*
