# ANSI Color Support for Tool Output

## Summary

Add rendering of ANSI SGR escape sequences (colors + text styles) in tool output displays. Uses `anser` for parsing and a curated 16-color dark-theme ANSI palette tuned for contrast on the `--card-inset` background.

## Decisions

- **Scope**: Standard 8+8 colors (normal + bright) plus bold, dim, italic, underline, strikethrough. No 256-color or 24-bit RGB.
- **Contrast**: Curated dark-theme palette with all colors targeting WCAG AA (4.5:1) contrast ratio against `--card-inset` (`oklch(0.16 0.03 255)`). Designed at CSS-variable time, not computed at render time.
- **Parsing location**: Frontend only (TypeScript). Raw strings flow unchanged from Rust → IPC → store. No backend changes.
- **Library**: `anser` — lightweight parser that converts ANSI strings to structured data. Used instead of `ansi-to-react` for more control over DOM output.
- **Unrecognized sequences**: Stripped silently. No raw escape codes leak through.
- **Text style mapping**: Direct CSS equivalents — bold → `font-weight: bold`, dim → `opacity: 0.6`, italic → `font-style: italic`, underline → `text-decoration: underline`, strikethrough → `text-decoration: line-through`.

## Architecture

### Components involved

- `src/globals.css` — 16 new CSS custom properties for the ANSI palette, plus utility classes
- `src/lib/ansi.ts` — Thin wrapper around `anser` that parses ANSI strings into styled segments
- `src/components/IterationGroup.tsx` — Update `ToolOutputSection` to render styled spans instead of plain text

### What doesn't change

- Rust backend — raw strings flow through unchanged
- Store / types — no data model changes
- Markdown rendering path for Agent tool output — untouched
- Truncation logic — works the same, just on styled spans instead of plain text

## ANSI Color Palette

16 CSS custom properties tuned for readability on `--card-inset` background:

```css
--ansi-black:              oklch(0.35 0.01 250);
--ansi-red:                oklch(0.65 0.20 25);
--ansi-green:              oklch(0.65 0.18 145);
--ansi-yellow:             oklch(0.75 0.15 85);
--ansi-blue:               oklch(0.60 0.15 250);
--ansi-magenta:            oklch(0.65 0.18 320);
--ansi-cyan:               oklch(0.65 0.12 195);
--ansi-white:              oklch(0.80 0.01 250);

--ansi-bright-black:       oklch(0.50 0.01 250);
--ansi-bright-red:         oklch(0.75 0.20 25);
--ansi-bright-green:       oklch(0.75 0.18 145);
--ansi-bright-yellow:      oklch(0.85 0.15 85);
--ansi-bright-blue:        oklch(0.70 0.15 250);
--ansi-bright-magenta:     oklch(0.75 0.18 320);
--ansi-bright-cyan:        oklch(0.75 0.12 195);
--ansi-bright-white:       oklch(0.90 0.01 250);
```

Notes:
- `--ansi-black` lifted to `0.35` lightness so it's visible on the dark background
- `--ansi-yellow` / `--ansi-bright-yellow` close to existing `--primary` gold for consistency

## Parser Module (`src/lib/ansi.ts`)

```typescript
import Anser from "anser";

export interface AnsiSegment {
  text: string;
  classes: string;
}

export function parseAnsi(raw: string): AnsiSegment[] {
  const parsed = Anser.ansiToJson(raw, { use_classes: true });
  return parsed
    .filter((entry) => entry.content.length > 0)
    .map((entry) => {
      const classes: string[] = [];
      if (entry.fg) classes.push(`ansi-fg-${entry.fg}`);
      if (entry.bg) classes.push(`ansi-bg-${entry.bg}`);
      if (entry.decoration === "bold") classes.push("ansi-bold");
      if (entry.decoration === "dim") classes.push("ansi-dim");
      if (entry.decoration === "italic") classes.push("ansi-italic");
      if (entry.decoration === "underline") classes.push("ansi-underline");
      if (entry.decoration === "strikethrough") classes.push("ansi-strikethrough");
      return { text: entry.content, classes: classes.join(" ") };
    });
}
```

## CSS Classes

Utility classes mapping ANSI color names to the palette custom properties:

- `.ansi-fg-{color}` → `color: var(--ansi-{color})`
- `.ansi-bg-{color}` → `background-color: var(--ansi-{color})`
- `.ansi-bold` → `font-weight: bold`
- `.ansi-dim` → `opacity: 0.6`
- `.ansi-italic` → `font-style: italic`
- `.ansi-underline` → `text-decoration: underline`
- `.ansi-strikethrough` → `text-decoration: line-through`

## Component Integration

In `ToolOutputSection`, replace plain text line rendering:

```tsx
// Before:
{lines.map((line, li) => (
  <span key={li}>{line}{li < displayedLines.length - 1 ? "\n" : ""}</span>
))}

// After:
{lines.map((line, li) => (
  <span key={li}>
    {parseAnsi(line).map((seg, j) =>
      seg.classes
        ? <span key={j} className={seg.classes}>{seg.text}</span>
        : seg.text
    )}
    {li < displayedLines.length - 1 ? "\n" : ""}
  </span>
))}
```

## Testing

- Unit tests for `parseAnsi()` covering all color/style/reset/edge cases
- Component tests in `IterationGroup.test.tsx` verifying ANSI-styled spans render correctly
- E2E test verifying colored output renders with correct classes and no raw escape codes

---

## Implementation Plan

### Task 1: Install `anser` dependency

Install the `anser` npm package and its type definitions.

**Files to modify:**
- `package.json`
- `package-lock.json`

**Details:**
- Run `npm install anser`
- `anser` ships its own TypeScript types, no separate `@types/anser` needed

**Checklist:**
- [x] Run `npm install anser`
- [x] Verify `anser` appears in `package.json` dependencies
- [x] Verify `npx tsc --noEmit` passes

---

### Task 2: Add ANSI palette CSS custom properties and utility classes

Add the 16-color palette and corresponding CSS utility classes to `globals.css`.

**Files to modify:**
- `src/globals.css`

**Pattern reference:** Existing custom properties in `src/globals.css:64-101`

**Details:**
- Add 16 `--ansi-*` custom properties inside the `:root` block
- Add `.ansi-fg-*` classes (16 foreground colors)
- Add `.ansi-bg-*` classes (16 background colors)
- Add `.ansi-bold`, `.ansi-dim`, `.ansi-italic`, `.ansi-underline`, `.ansi-strikethrough` classes

**Checklist:**
- [x] Add `--ansi-*` custom properties to `:root`
- [x] Add foreground color classes
- [x] Add background color classes
- [x] Add text decoration classes (used `text-decoration-line` instead of `text-decoration` so underline+strikethrough can coexist)
- [x] Verify `npx tsc --noEmit` passes

---

### Task 3: Create `parseAnsi` module with unit tests

Create the parser module that wraps `anser` and maps output to CSS class names.

**Files to create:**
- `src/lib/ansi.ts`
- `src/lib/ansi.test.ts`

**Pattern reference:** `src/lib/utils.ts` (existing lib module), `src/event-format.test.ts` (unit test pattern)

**Details:**
- Export `AnsiSegment` interface and `parseAnsi` function
- Use `Anser.ansiToJson()` with `use_classes: true`
- Map `fg`/`bg` to `ansi-fg-{color}` / `ansi-bg-{color}` class names
- Map `decorations` (plural array, not singular `decoration`) to corresponding `ansi-*` class names — `decoration` only holds the last one
- Strip `ansi-` prefix from `entry.fg`/`entry.bg` before constructing class names (Anser returns e.g. `"ansi-red"`, not `"red"`)
- Filter out empty content entries

**Unit tests to include:**
- Basic foreground color (`\x1b[31m` → `ansi-fg-red`)
- Bright foreground color (`\x1b[91m` → `ansi-fg-bright-red`)
- Background color (`\x1b[42m` → `ansi-bg-green`)
- Stacked styles (bold + color → both classes)
- Each text decoration (bold, dim, italic, underline, strikethrough)
- Reset mid-string (`\x1b[0m` clears styles)
- Plain text (no ANSI) → single segment, empty classes string
- Empty string → empty array
- Malformed sequences stripped (no raw escape chars in output text)

**Checklist:**
- [x] Create `src/lib/ansi.ts`
- [x] Create `src/lib/ansi.test.ts`
- [x] All unit tests pass (`npm test`)
- [x] Verify `npx tsc --noEmit` passes

---

### Task 4: Integrate ANSI rendering into `ToolOutputSection` with component tests

Update the `ToolOutputSection` component to render ANSI-styled spans for non-Agent tool output.

**Files to modify:**
- `src/components/IterationGroup.tsx`
- `src/components/IterationGroup.test.tsx`

**Pattern reference:** `src/components/IterationGroup.tsx:96-103` (current plain text rendering), `src/components/IterationGroup.test.tsx:957-1192` (tool output test section)

**Details:**
- Import `parseAnsi` from `../lib/ansi`
- Replace plain text `{line}` with `parseAnsi(line).map(...)` rendering
- Only apply to the non-Agent `<pre>` path (Agent output stays as Markdown)
- Unstyled segments render as bare text nodes (no unnecessary `<span>` wrappers)

**Component tests to add:**
- Tool output with ANSI color codes renders `<span>` elements with correct `ansi-fg-*` classes
- Tool output with bold renders `<span>` with `ansi-bold` class
- Tool output with no ANSI codes renders without any `ansi-*` class spans (regression check)
- ANSI codes are stripped from visible text content (no raw escape characters)
- Truncation still works correctly with ANSI-colored output

**Checklist:**
- [x] Import `parseAnsi` in `IterationGroup.tsx`
- [x] Update `ToolOutputSection` rendering
- [x] Add component tests to `IterationGroup.test.tsx`
- [x] All unit and component tests pass (`npm test`)
- [x] Verify `npx tsc --noEmit` passes

---

### Task 5: E2E test for ANSI color rendering

Add an E2E test that verifies ANSI-colored tool output renders with the correct CSS classes in the browser.

**Files to create:**
- `e2e/ansi-colors.test.ts`

**Pattern reference:** `e2e/run-detail.test.ts` (navigation pattern, mock setup, fixture usage)

**Details:**
- Mock a session with a tool_use event containing ANSI-colored `tool_output`
- Navigate to the detail view and expand the event
- Verify `<span>` elements with `ansi-fg-*` classes are present
- Verify no raw escape characters (`\x1b`, `\u001b`) appear in visible text
- Verify plain (unstyled) text does not get wrapped in ANSI spans

**Checklist:**
- [x] Create `e2e/ansi-colors.test.ts`
- [x] E2E test passes (`npm run test:e2e`)

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Install `anser` dependency | Done |
| 2 | Add ANSI palette CSS and utility classes | Done |
| 3 | Create `parseAnsi` module with unit tests | Done |
| 4 | Integrate ANSI rendering into `ToolOutputSection` with component tests | Done |
| 5 | E2E test for ANSI color rendering | Done |
