# Yarr Design System — "Forge"

## Philosophy & Feel

An **industrial, utilitarian developer-tool aesthetic** inspired by VS Code and Docker Desktop. The system is dark-only — dark charcoal surfaces with a **warm gold primary accent** for brand identity.

Interfaces should be:

- **Dense and information-rich** — prioritize content over whitespace
- **Restrained in color** — reserve bright accents for interactive elements and status signals; let content breathe against muted surfaces
- **Subtle in elevation** — convey depth through border intensity and background lightness shifts, not drop shadows (reserve `box-shadow` for popovers/dropdowns only)
- **Tight in radii** — small, consistent border radii throughout

## Typography

- **Sans (UI text):** Outfit — weights 300–700
- **Mono (code/labels):** JetBrains Mono

Both fonts must be explicitly loaded (Google Fonts or local). Do not fall back to system font stacks for UI text — the branded typeface is a core part of the identity.

**Hierarchy:**

| Level | Classes | Usage |
|-------|---------|-------|
| Page title | `text-3xl font-bold` | Top-level headings |
| Section title | `text-xl font-semibold` | Card titles, panel headers |
| Body | `text-base` | Primary content |
| Secondary | `text-sm text-muted-foreground` | Descriptions, metadata |
| Caption | `text-xs text-muted-foreground` | Timestamps, helper text |

Uppercase mono labels (`text-xs font-mono uppercase tracking-widest text-muted-foreground`) are used for section/category headers within components.

**Small text rule:** Gold primary (`--primary` at L=0.85) passes WCAG AA on `--background` (L=0.22) at `text-base` and above. For `text-xs` or `text-sm` on dark surfaces, prefer `--foreground` (L=0.9) or `--primary-light` (L=0.92) to maintain legibility.

## Color Palette

All colors are defined as OKLCH values in CSS custom properties. **No hardcoded hex values or Tailwind palette names** (e.g. `amber-950`, `gray-700`) should appear in component code — always reference tokens.

### Core Tokens

| Role | Token | OKLCH | Notes |
|------|-------|-------|-------|
| Background | `--background` | `0.22 0.02 270` | Page-level surface |
| Card | `--card` | `0.26 0.04 250` | Elevated surface (bumped from 0.24 for clearer separation) |
| Card inset | `--card-inset` | `0.20 0.03 255` | Sunken areas within cards: terminal output, code blocks, nested panels |
| Popover | `--popover` | `0.26 0.04 250` | Menus, dropdowns |
| Primary (gold) | `--primary` | `0.85 0.15 85` | Brand accent, interactive elements |
| Primary light | `--primary-light` | `0.92 0.10 85` | Small text on dark surfaces where gold is too low-contrast |
| Border | `--border` | `0.30 0.01 250` | Default border — hint of card's blue hue for cohesion |
| Border hover | `--border-hover` | `0.40 0.02 250` | Hovered borders on interactive elements |
| Foreground | `--foreground` | `0.90 0 0` | Primary text |
| Muted FG | `--muted-foreground` | `0.55 0 0` | Secondary text (dropped from 0.6 for more contrast from foreground) |

### Semantic Status Tokens

| Role | Token | OKLCH | Text usage |
|------|-------|-------|------------|
| Destructive | `--destructive` | `0.55 0.2 25` | Errors, delete actions |
| Warning | `--warning` | `0.75 0.15 70` | Caution states |
| Success | `--success` | `0.70 0.15 165` | Complete, healthy |
| Info | `--info` | `0.70 0.10 250` | Informational, in-progress |

Each status token should have a corresponding background variant at ~L=0.25 for badge/chip backgrounds (e.g. `--destructive-muted: oklch(0.25 0.05 25)`).

### Status Colors for Indicators

Status dots and text labels must use these tokens — not inline hex objects:

| Status | Dot color | Text class |
|--------|-----------|------------|
| Running / active | `bg-warning` | `text-warning` |
| Complete / success | `bg-success` | `text-success` |
| Failed / error | `bg-destructive` | `text-destructive` |
| Idle / queued | `bg-muted-foreground` | `text-muted-foreground` |
| In progress | `bg-info` | `text-info` |

Full token definitions: `src/globals.css:58-91`

## Elevation Model

| Level | Usage | Surface | Border |
|-------|-------|---------|--------|
| 0 | Page background | `bg-background` | none |
| 0.5 | Sunken/inset areas within cards | `bg-card-inset` | `border-border` or none |
| 1 | Cards, list items | `bg-card`, `border-border` | `border-border` |
| 2 | Popovers, menus | `bg-popover`, `border-border` | `border-border` |
| 3 | Dropdowns, dialogs | `bg-popover` | `border-border` + `shadow-lg` |

Level 0.5 is for embedded content that should read as "recessed" within a card — terminal output, code blocks, log viewers, progress bar tracks.

## Spacing

Uses Tailwind's spacing scale. Key stops:

| Token | Value | Usage |
|-------|-------|-------|
| `gap-1` | 0.25rem | Tight inline (icon pairs, badge groups) |
| `gap-2` | 0.5rem | Icon-to-label, inline elements |
| `gap-3` | 0.75rem | List item internal spacing |
| `gap-4` / `p-4` | 1rem | Card padding (compact/dashboard cards) |
| `gap-6` / `p-6` | 1.5rem | Card padding (form/detail cards), group spacing |
| `p-8` | 2rem | Page padding |
| `space-y-12` | 3rem | Section separation |

## Border Radius

Base radius: `0.375rem`. Variants via CSS custom properties:

- `--radius-sm`: base − 0.125rem
- `--radius-md`: base
- `--radius-lg`: base + 0.125rem
- `--radius-xl`: base + 0.25rem

Defined at: `src/globals.css:40-43`

## Transitions & Motion

### Standard Transitions

| Property | Duration | Easing | Usage |
|----------|----------|--------|-------|
| `color`, `background-color`, `border-color`, `opacity` | `150ms` | `ease-out` | All interactive elements |
| `transform` | `200ms` | `ease-out` | Chevron rotations, expand/collapse |
| `max-height`, `height` | `200ms` | `ease-in-out` | Accordion, collapsible sections |

**Rule:** Never use `transition-all` — it animates layout properties (`width`, `padding`, `margin`) causing layout thrash. Always specify which properties transition.

Preferred Tailwind pattern: `transition-colors duration-150` for color-only transitions.

### Animated States

- **Pulsing dots:** `animate-pulse` on status dots for running/active states. Must include `motion-safe:` prefix to respect `prefers-reduced-motion`.
- **Blinking cursor:** `animate-blink` (defined in globals.css) for terminal cursor simulation.

### Reduced Motion

Wrap all decorative animations with `motion-safe:`:
```
motion-safe:animate-pulse
```
Functional animations (expand/collapse, tab switches) should still run but may use `motion-reduce:duration-0` to make them instant.

## Interactive States

All interactive elements must define these states:

### Focus

Keyboard focus uses a **3px ring** in the primary gold color:
```
focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none
```
This is the standard across buttons, inputs, selects, and any clickable element. Never remove focus indicators.

### Hover

- **Buttons:** Opacity shift (`hover:bg-primary/90`) or background swap
- **Cards/list items:** Border highlight (`hover:border-primary/30`) via `transition-colors duration-150`
- **Ghost elements:** Background reveal (`hover:bg-accent`)

### Active / Pressed

Interactive elements should have a subtle pressed state:
```
active:scale-[0.98]
```
Keep this minimal — a barely perceptible press, not a bouncy animation.

### Disabled

```
disabled:pointer-events-none disabled:opacity-50
```
Applied consistently across all interactive components.

### Selected

Selected items in lists, tabs, and toggles use `bg-accent` background with `text-accent-foreground` or a `border-b-2 border-primary` underline for tab-style selection.

## Scrollbars

Dark, minimal scrollbars that match the UI:

- Width: `6px`
- Track: transparent
- Thumb: `var(--border)` with `border-radius: 3px`
- Thumb hover: `var(--muted-foreground)`
- Firefox: `scrollbar-width: thin; scrollbar-color: var(--border) transparent`

Defined at: `src/globals.css:100-122`

## Key Components

### Button
`src/components/ui/button.tsx:7` — CVA-based with variants and sizes.

**Variants:** `default` (gold primary), `secondary`, `outline`, `ghost`, `destructive`, `link`

**Sizes:** `xs` (h-6), `sm` (h-8), `default` (h-9), `lg` (h-10), `icon-xs`, `icon-sm`, `icon`, `icon-lg`

### Badge
`src/components/ui/badge.tsx:7` — Rounded-full pills for status display.

**Variants:** `default`, `secondary`, `outline`, `ghost`, `destructive`, `warning`, `success`, `completed`, `cancelled`, `failed`, `maxiters`

Badge status variants (`warning`, `success`, `completed`, `cancelled`, `failed`) must use semantic token backgrounds (e.g. `bg-[oklch(var(--success-muted))]`) rather than hardcoded Tailwind palette names.

### Card
`src/components/ui/card.tsx:5` — Rounded-xl container with border and shadow-sm.

Sub-components: `CardHeader` (:18), `CardTitle` (:31), `CardDescription` (:41), `CardAction` (:51), `CardContent` (:64), `CardFooter` (:74)

**Variants:**
- **Default** (`p-6 gap-6`): Forms, detail views, settings panels
- **Compact** (`p-4 gap-3`): Dashboard cards, list items — dense information display

### Progress Bar
Used in dashboard cards for plan progress. Must use tokens, not inline hex.

- Track: `bg-card-inset` with `rounded-full`
- Fill: `bg-success` (complete) or `bg-info` (in-progress) with `rounded-full`
- Height: `h-1.5` (inline/subtle) or `h-2` (prominent)

### Breadcrumb
`src/components/ui/breadcrumb.tsx` — Navigation breadcrumbs for detail page hierarchy.

### Form Controls
- **Input:** `src/components/ui/input.tsx`
- **Textarea:** `src/components/ui/textarea.tsx`
- **Label:** `src/components/ui/label.tsx`
- **Checkbox:** `src/components/ui/checkbox.tsx`
- **Select:** `src/components/ui/select.tsx`

### Overlay / Layout
- **Dialog:** `src/components/ui/dialog.tsx`
- **Sheet:** `src/components/ui/sheet.tsx`
- **Popover:** `src/components/ui/popover.tsx`
- **Command:** `src/components/ui/command.tsx`
- **Tabs:** `src/components/ui/tabs.tsx`
- **Accordion:** `src/components/ui/accordion.tsx`
- **Collapsible:** `src/components/ui/collapsible.tsx`

### Toast / Notifications
`src/components/ui/sonner.tsx` — Sonner-based toasts. Use `toast.error(actualMessage)` for errors (surface real messages, not vague placeholders).

## Icons

Lucide React icons throughout. Common: `Play`, `Square`, `RotateCcw`, `Terminal`, `GitBranch`, `FolderOpen`, `Settings`, `Zap`, `ChevronRight`, `CheckCircle2`, `XCircle`, `AlertTriangle`.

Default sizing: `size-4` inline with text, `size-5` in icon grids.

## Patterns

### Status Indicators
Colored dots (`size-2 rounded-full`) with `motion-safe:animate-pulse` for active states. Pair with Lucide status icons (`CheckCircle2`, `XCircle`, `AlertTriangle`) and semantic text colors (`text-success`, `text-destructive`, `text-warning`).

Status dots are purely visual — always pair with an `aria-label` or adjacent text label for screen readers.

### Dashboard Cards (ActionCard)
Clickable card-as-button for the dashboard grid. Compact padding (`p-4`), `bg-card border-border` with `hover:border-primary/30 transition-colors duration-150`. Contains: status dot, title, metadata row (badges, timestamps, metrics), optional progress bar.

### List Items
`bg-card border-border` rows with `hover:border-primary/30 transition-colors duration-150`. Icon left, content center, badge/chevron right.

### Empty States
Dashed border container (`border-dashed border-border`), centered icon + text + CTA button. Icon in `text-muted-foreground`, heading in `text-foreground`, description in `text-muted-foreground`.

### Truncation & Overflow
Dense UIs need predictable overflow behavior:
- **Repo paths:** `truncate` (single-line ellipsis) with `title` attribute for full path on hover
- **Branch names:** `truncate max-w-[200px]` — cap width to prevent layout blowout
- **Prompt previews:** `line-clamp-2` for multi-line truncation
- **Timestamps:** Never truncate — use relative format ("2m ago") to keep compact

### Keyboard Shortcuts
Display with `<kbd>` styling: `bg-card-inset border-border rounded-sm px-1.5 py-0.5 text-xs font-mono`. Group related shortcuts with a muted label.

## Accessibility

### Contrast Requirements
OKLCH lightness makes contrast easy to verify. Minimum lightness differences for text on surfaces:

| Surface (L) | Min text lightness | Passes |
|-------------|-------------------|--------|
| Background (0.22) | 0.62+ | WCAG AA |
| Card (0.26) | 0.65+ | WCAG AA |
| Card inset (0.20) | 0.60+ | WCAG AA |

Gold primary (L=0.85) passes on all dark surfaces at `text-base`+. Use `--primary-light` (L=0.92) for small text.

### Focus Visibility
All interactive elements must have visible focus indicators. Never suppress `outline` or `ring` on `:focus-visible`. The gold ring ensures keyboard users can always locate the active element.

### Reduced Motion
All decorative animations gated behind `motion-safe:`. Functional transitions (tab switches, accordions) use `motion-reduce:duration-0`.

### Screen Reader Support
- Status dots: pair with `aria-label` or visible text
- Icon-only buttons: require `aria-label`
- Live regions: toast notifications use `role="status"` (handled by Sonner)

## Reference

- **Design system showcase page:** `src/pages/DesignSystem.tsx` (route: `/design-system`)
- **Global CSS tokens:** `src/globals.css`
- **All UI components:** `src/components/ui/`
