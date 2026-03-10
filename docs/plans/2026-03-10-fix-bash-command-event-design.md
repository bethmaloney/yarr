# Fix Bash Command Event Display

## Overview

Bash tool_use events from Claude's stream-json output include both a `command` field and a `description` field. Currently, the UI displays the raw `command` as the event title (e.g., `Bash: npm run typecheck 2>&1 || npx --no-install tsc --noEmit 2>&1`), which is long and hard to scan. The fix swaps the display so that `description` is shown as the title when available, making the event list more user-friendly. The full command remains visible in the expanded detail view.

**Example input:**
```json
{
  "command": "npm run typecheck 2>&1 || npx --no-install tsc --noEmit 2>&1 || ./node_modules/.bin/tsc --noEmit 2>&1 | tail -10",
  "description": "Try alternative TypeScript check commands"
}
```

**Before:** `Bash: npm run typecheck 2>&1 || npx --no-install tsc --noEmit 2>&1 || ...`
**After:** `Bash: Try alternative TypeScript check commands`

## Task 1: Update `toolSummary` to prefer `description` over `command`

**Files to modify:**
- `src/event-format.ts`

**Pattern reference:** The existing Bash case at line 93-94:
```typescript
case "Bash":
  return input.command ? `${name}: ${input.command}` : name;
```

**Checklist:**
- [x] Change the Bash case to prefer `input.description` when present, falling back to `input.command`
- [x] New logic: `input.description ? \`${name}: ${input.description}\` : input.command ? \`${name}: ${input.command}\` : name`

## Task 2: Update tests

**Files to modify:**
- `src/event-format.test.ts`

**Pattern reference:** Existing Bash test at lines 183-191 and 322-329.

**Checklist:**
- [x] Update the existing test at line 191 (`expect(label).toBe("[2] Bash: npm test")`) — this test has no `description` field, so it should still show the command (fallback behavior unchanged)
- [x] Add a new test: Bash tool_use with both `command` and `description` fields — assert that `description` is shown
- [x] Add a new test: Bash tool_use with only `description` (no `command`) — assert that `description` is shown
- [x] Update the `toolSummary` test at line 328 — this has no `description`, so behavior is unchanged; verify it still passes
- [x] Add a `toolSummary` test with `description` present — assert description is preferred

## Progress

| Task | Status | Notes |
|------|--------|-------|
| 1. Update `toolSummary` | Done | Single line change in `event-format.ts` |
| 2. Update tests | Done | 4 new tests added, all 43 tests pass |
