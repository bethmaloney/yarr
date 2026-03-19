# Check Failure UX — Expose Fix-Agent Configuration

## Problem

The check system already supports spawning a Claude agent on failure with a custom prompt and model, but the UI only exposes name, command, when, timeout, and retries. Users don't know these capabilities exist and resort to writing wrapper scripts.

## Solution

Add a collapsible "On Failure" section to each check card that surfaces the existing `prompt` and `model` fields, and move `retries` into this section since it only applies to failure handling. Update `build_fix_prompt` to support `{{output}}` template variable for explicit output placement.

## UI Design

### Check Card Layout

The existing card structure (name, when toggle, command, timeout) stays. A new collapsible "On Failure" section is added below.

**Collapsed (default):**
```
┌─[gold left border]──────────────────────────────────────────┐
│  [Name input]        [Every iteration | After completion] [×] │
│  Command: [npm run lint__________]           Timeout: [300]   │
│  ▸ On Failure                                                  │
└───────────────────────────────────────────────────────────────┘
```

**Expanded:**
```
┌─[gold left border]──────────────────────────────────────────┐
│  [Name input]        [Every iteration | After completion] [×] │
│  Command: [npm run lint__________]           Timeout: [300]   │
│  ▾ On Failure                                                  │
│  ┌─ bg-card-inset ─────────────────────────────────────────┐  │
│  │  Model: [Inherit from session ▾]       Retries: [1]     │  │
│  │                                                          │  │
│  │  Fix Prompt:                                             │  │
│  │  ┌──────────────────────────────────────────────────┐    │  │
│  │  │ Fix the lint errors shown below.                 │    │  │
│  │  │                                                  │    │  │
│  │  └──────────────────────────────────────────────────┘    │  │
│  │  Leave blank for default prompt. Use {{output}} to       │  │
│  │  inject the check's error output.                        │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

### Design System Alignment

- **Collapsible trigger**: Uses `<Collapsible>` component. Trigger is a button with `ChevronRight` icon that rotates 90° on open (`transition-transform duration-200`). Text "On Failure" in `text-xs text-muted-foreground`. Styled as a subtle divider row, not a prominent header.
- **Inset panel**: `bg-card-inset rounded-md p-3` — elevation 0.5, visually recessed within the card.
- **Model input**: Free text `<Input>` with `font-mono` (matches existing model input pattern elsewhere in the app). Placeholder: "Inherit from session". Placed inline with retries in a `grid-cols-[1fr_auto]` row.
- **Retries**: Moves from the command row into the "On Failure" section since it only applies to failure handling. Same `NumberInput` as today.
- **Prompt textarea**: `<Textarea>` with `font-mono`, 3 rows, placeholder: `"e.g. Fix all lint errors in the codebase."`. Resizable vertically.
- **Helper text**: `text-xs text-muted-foreground` caption below the textarea explaining `{{output}}` and the default behavior.
- **Disabled state**: All fields in the "On Failure" section respect `session.running` with `disabled` + `opacity-60`.

### Command Row Simplification

With retries moved to "On Failure", the command row becomes `grid-cols-[1fr_auto]`:
- Command input (1fr)
- Timeout input (auto, w-24)

## Backend Change

### `build_fix_prompt` — `{{output}}` template variable

Current behavior:
- No custom prompt → generates a full default prompt with check name, command, and output
- Custom prompt → appends output block at the end

New behavior:
- No custom prompt → unchanged (same default prompt)
- Custom prompt containing `{{output}}` → replaces `{{output}}` with the actual output (no appending)
- Custom prompt without `{{output}}` → unchanged (appends output block at the end, backward-compatible)

This is a single `if custom.contains("{{output}}")` branch in `build_fix_prompt`.

## Type Changes

None required. The `Check` type in both TypeScript and Rust already has `prompt: Option<String>` / `prompt?: string` and `model: Option<String>` / `model?: string`.

## Testing

### Frontend
- E2E: Expand "On Failure" section, fill prompt/model, verify they persist on save
- E2E: Verify default collapsed state
- E2E: Verify fields disabled while session running

### Backend
- Unit test: `build_fix_prompt` with `{{output}}` in custom prompt does replacement
- Unit test: `build_fix_prompt` without `{{output}}` in custom prompt still appends (backward compat)

---

## Implementation Plan

### Task 1: Backend — `{{output}}` template variable in `build_fix_prompt`

Add support for `{{output}}` placeholder replacement in custom prompts.

**Files to modify:**
- `src-tauri/src/session.rs` — `build_fix_prompt` function (line 219)

**Pattern reference:** existing `build_fix_prompt` at `src-tauri/src/session.rs:219-244`

**Details:**
- In the `Some(custom)` branch, check if `custom.contains("{{output}}")`
- If yes: `custom.replace("{{output}}", output)` — no appending
- If no: keep current behavior (append output block)
- Also support `{{command}}` and `{{name}}` for symmetry

**Checklist:**
- [x] Add `{{output}}` replacement branch in `build_fix_prompt`
- [x] Add `{{command}}` and `{{name}}` replacement support
- [x] Add unit test: custom prompt with `{{output}}` does replacement, no appending
- [x] Add unit test: custom prompt with `{{output}}` and `{{command}}` does both replacements
- [x] Add unit test: custom prompt without `{{output}}` still appends (backward compat — existing test covers this, verify it still passes)
- [x] Run `cargo test` in `src-tauri/`

---

### Task 2: Frontend — Add "On Failure" collapsible section to check cards

Add a collapsible section within each check card that exposes the prompt, model, and retries fields.

**Files to modify:**
- `src/pages/RepoDetail.tsx` — checks tab (lines 1299-1483)

**Pattern references:**
- Collapsible usage: `src/pages/Home.tsx:295-362`
- Textarea usage: `src/pages/RepoDetail.tsx:1552-1558` (git sync prompt)
- Model input: `src/pages/RepoDetail.tsx:959-965` (free text Input)
- NumberInput: already used in check cards for timeout

**Details:**
- Import `Collapsible`, `CollapsibleTrigger`, `CollapsibleContent` from `@/components/ui/collapsible`
- Remove the empty `import {} from "@/components/ui/accordion"` import
- Move retries `NumberInput` from the command row into the "On Failure" section
- Command row becomes `grid-cols-[1fr_auto]` (command + timeout only)
- Add collapsible "On Failure" section after the command row:
  - Trigger: `ChevronRight` icon (rotates on open) + "On Failure" text in `text-xs text-muted-foreground`
  - Content: `bg-card-inset rounded-md p-3` inset panel containing:
    - Row 1: Model `Input` (placeholder "Inherit from session", `font-mono`) + Retries `NumberInput` in `grid-cols-[1fr_auto]`
    - Row 2: "Fix Prompt" label + `Textarea` (`font-mono`, 3 rows, placeholder "e.g. Fix all lint errors in the codebase.")
    - Row 3: Helper text `text-xs text-muted-foreground`: "Leave blank for default prompt. Use {{output}} to inject check output, {{command}} for the check command."
- Wire `prompt` and `model` fields to check state updates (same pattern as other fields)
- All fields disabled when `session.running`
- Import `ChevronRight` from lucide-react if not already imported

**Checklist:**
- [x] Import Collapsible components
- [x] Remove empty accordion import
- [x] Restructure command row to `grid-cols-[1fr_auto]` (drop retries)
- [x] Add collapsible "On Failure" section with trigger
- [x] Add model Input field
- [x] Move retries NumberInput into collapsible section
- [x] Add prompt Textarea field
- [x] Add helper text with `{{output}}` / `{{command}}` / `{{name}}` explanation
- [x] Wire all new fields to check state updates
- [x] Verify all fields respect `session.running` disabled state
- [x] Run `npx tsc --noEmit`
- [x] Run `npx eslint .`

---

### Task 3: Frontend — Update E2E tests for check configuration

The existing E2E tests in `e2e/checks.test.ts` are stale — they reference a `.checks` collapsible + accordion structure that doesn't match the current settings sheet + tabs UI. Rewrite them to match the current UI and add tests for the new "On Failure" section.

**Files to modify:**
- `e2e/checks.test.ts`

**Pattern reference:** `e2e/checks.test.ts` (existing test structure, `navigateToRepoDetail` helper), `e2e/fixtures.ts` (mock setup)

**Details:**
- Fix `navigateToRepoDetail` to open settings sheet and navigate to the Checks tab
- Update selectors: replace `.checks` + `[data-slot="collapsible-trigger"]` with settings sheet + tab navigation
- Keep `.check-entry` selector (still valid)
- Remove `[data-slot="accordion-trigger"]` references (check fields are always visible, no accordion)
- Add new test data: `repoWithTwoChecks` already has `prompt` and `model` fields — good
- Add tests for the "On Failure" section:
  - Expand "On Failure", verify model/prompt/retries fields render
  - Pre-existing check with prompt/model displays values
  - New check has empty prompt and model
  - All "On Failure" fields disabled while running

**Checklist:**
- [x] Fix `navigateToRepoDetail` to open settings sheet → Checks tab
- [x] Update all selectors to match current UI structure
- [x] Update default value tests for new field locations (retries in "On Failure")
- [x] Add test: "On Failure" section expands to show model, prompt, retries
- [x] Add test: pre-existing check with prompt/model shows values
- [x] Add test: prompt and model fields disabled while running
- [x] Run `npm run test:e2e`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Backend: `{{output}}` template variable | Done |
| 2 | Frontend: "On Failure" collapsible section | Done |
| 3 | Frontend: Update E2E tests | Done |
