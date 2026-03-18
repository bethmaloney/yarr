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
- **Model select**: Standard `<Select>` component. Options: "Inherit from session" (value: `""`), "Sonnet", "Opus", "Haiku". Placed inline with retries in a `grid-cols-[1fr_auto]` row.
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
