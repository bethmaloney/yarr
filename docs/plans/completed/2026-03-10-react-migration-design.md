# React Migration Design

## Overview

Migrate the Yarr frontend from Svelte 5 to React 19. Replicate the current UI as-is (minor layout tweaks acceptable). A UI polish pass will follow separately.

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | React 19 | User preference |
| Styling | Tailwind CSS v4 + shadcn/ui | Utility-first CSS with accessible Radix-based component primitives. Components live in the repo, fully customizable. Good fit for a desktop app with a custom dark theme. |
| State management | Zustand | Single store for sessions (event-driven) and repos (CRUD). No providers/context needed. Simple API, automatic re-render optimization. |
| Routing | react-router v7 | Gives browser-style back/forward in Tauri webview. 5 routes, lightweight. |
| Build | Vite + @vitejs/plugin-react-swc | Faster builds than babel plugin. Vite stays as-is. |
| Testing | Vitest + @testing-library/react + Playwright | Unit tests via testing-library, E2E tests unchanged (Playwright against Vite dev server). |

## Dependencies

### Remove

- `svelte`, `@sveltejs/vite-plugin-svelte`
- `svelte-eslint-parser`, `eslint-plugin-svelte`
- `prettier-plugin-svelte`

### Add

- `react`, `react-dom` (v19)
- `react-router` (v7)
- `@vitejs/plugin-react-swc`
- `tailwindcss`, `@tailwindcss/vite` (v4)
- `zustand`
- shadcn/ui dependencies: `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`
- `@types/react`, `@types/react-dom`
- `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
- `@testing-library/react`, `@testing-library/jest-dom`

### Unchanged

- `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-store`
- `vitest`, `@playwright/test`
- `typescript`, `eslint`, `prettier`, `vite`

## File Structure

```
src/
  components/
    ui/                    # shadcn/ui primitives
    RepoCard.tsx
    EventsList.tsx
    IterationGroup.tsx
  pages/
    Home.tsx
    RepoDetail.tsx
    History.tsx
    RunDetail.tsx
    OneShot.tsx
  hooks/
    useSessionManager.ts   # Tauri event listener, session state, sync logic
    useBranchInfo.ts       # Branch fetching logic
  lib/
    utils.ts               # shadcn/ui cn() helper
  store.ts                 # Zustand store

  # Unchanged pure TS modules:
  types.ts
  repos.ts
  recents.ts
  time.ts
  sort.ts
  event-display.ts
  event-format.ts
  iteration-groups.ts
  context-bar.ts
  oneshot-helpers.ts
  browser-mock.ts

  App.tsx                  # Router setup + store initialization
  main.tsx
  globals.css              # Tailwind directives + theme variables
```

## Routing

| Path | Component | Current equivalent |
|------|-----------|-------------------|
| `/` | `Home` | `currentView.kind === "home"` |
| `/repo/:repoId` | `RepoDetail` | `currentView.kind === "repo"` |
| `/repo/:repoId/oneshot` | `OneShot` | `currentView.kind === "oneshot"` |
| `/history` | `History` | `currentView.kind === "history"` (no repoId) |
| `/history/:repoId` | `History` | `currentView.kind === "history"` (with repoId) |
| `/run/:repoId/:sessionId` | `RunDetail` | `currentView.kind === "run"` |

## State Management (Zustand)

Single store with two concerns:

```ts
interface AppStore {
  // --- Repos ---
  repos: RepoConfig[]
  loadRepos: () => Promise<void>
  addLocalRepo: (path: string) => Promise<void>
  addSshRepo: (host: string, path: string) => Promise<void>
  updateRepo: (repo: RepoConfig) => Promise<void>

  // --- Sessions ---
  sessions: Map<string, SessionState>
  latestTraces: Map<string, SessionTrace>
  runSession: (repoId: string, repo: RepoPayload, planFile: string, ...) => Promise<void>
  stopSession: (repoId: string) => Promise<void>
  reconnectSession: (repoId: string) => Promise<void>

  // --- Init ---
  initialize: () => () => void   // returns cleanup function
}
```

`initialize()` is called once in `App.tsx` via `useEffect`. It:
- Loads repos and latest traces
- Starts the `listen("session-event", ...)` subscription
- Starts the 5-second `syncActiveSession` interval
- Returns the cleanup function (unlisten + clearInterval)

Map mutations use immutable updates:
```ts
set(state => {
  const next = new Map(state.sessions)
  next.set(repoId, { ...existing, ...updates })
  return { sessions: next }
})
```

## shadcn/ui Component Mapping

| Current pattern | shadcn/ui component |
|-----------------|---------------------|
| `<button class="add-btn">`, `"secondary"`, `"danger"` | `Button` with `variant` prop |
| `<input>`, `<textarea>` | `Input`, `Textarea` |
| `<label>` | `Label` |
| `<select>` | `Select` (Radix) |
| `<input type="checkbox">` | `Checkbox` |
| `.repo-card` button | `Card` |
| `<details>/<summary>` sections | `Collapsible` or `Accordion` |
| Branch dropdown with search | `Popover` + `Command` |
| Breadcrumbs nav | `Breadcrumb` |
| Status dot + label | `Badge` with custom variant |
| Connection test stepper | Custom (Tailwind only) |
| EventsList | Custom (Tailwind only) |

Scaffolded via shadcn CLI: Button, Input, Textarea, Label, Select, Checkbox, Card, Collapsible, Accordion, Popover, Command, Breadcrumb, Badge.

## Theming

Single dark theme via CSS variables in `globals.css`:

```css
@import "tailwindcss";

:root {
  --background: 234 25% 14%;        /* #1a1a2e */
  --foreground: 0 0% 88%;           /* #e0e0e0 */
  --card: 219 43% 16%;              /* #16213e */
  --card-foreground: 0 0% 88%;
  --primary: 51 78% 60%;            /* #e8d44d */
  --primary-foreground: 234 25% 14%;
  --secondary: 0 0% 20%;            /* #333 */
  --secondary-foreground: 0 0% 53%; /* #888 */
  --destructive: 0 72% 51%;         /* #dc2626 */
  --destructive-foreground: 0 0% 100%;
  --border: 0 0% 20%;               /* #333 */
  --input: 0 0% 20%;
  --ring: 51 78% 60%;               /* gold focus ring */
  --muted: 0 0% 20%;
  --muted-foreground: 0 0% 53%;
  --accent: 219 43% 20%;            /* #1a2744 hover */
  --accent-foreground: 0 0% 88%;
  --warning: 38 92% 50%;            /* #f59e0b */
  --success: 160 51% 49%;           /* #34d399 */
  --radius: 0.375rem;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
```

Custom mono font stack via Tailwind `font-mono` utility.

## Testing

### Unit tests

- Pure TS module tests (`time.test.ts`, `sort.test.ts`, etc.) — no changes needed.
- Component tests (`RepoCard.test.ts`, etc.) — rewrite using `@testing-library/react`. Same Tauri mock patterns, React rendering.

### E2E tests

- Playwright against Vite dev server — same approach.
- `fixtures.ts` Tauri IPC mocking via `window.__TAURI_INTERNALS__` — unchanged.
- Selector updates needed where element structure or test IDs shift.
- Route-based navigation may simplify some tests.

## Unchanged Modules

These 11 pure TypeScript files have no Svelte imports and transfer directly:

- `types.ts` — type definitions
- `repos.ts` — repo CRUD (uses @tauri-apps/plugin-store)
- `recents.ts` — recent items
- `time.ts` — time formatting
- `sort.ts` — sorting utilities
- `event-display.ts` — event display helpers
- `event-format.ts` — event formatting
- `iteration-groups.ts` — event grouping logic
- `context-bar.ts` — context color utility
- `oneshot-helpers.ts` — one-shot helpers
- `browser-mock.ts` — browser mocks

---

## Implementation Plan

### Task 1: Swap dependencies and build config

Remove Svelte packages, install React + Tailwind + shadcn/ui + Zustand + react-router. Update Vite config, tsconfig, and ESLint config. Verify `npm run dev` starts without errors (blank page is fine).

**Files to create/modify:**
- `package.json`
- `vite.config.ts`
- `tsconfig.json`
- `tsconfig.app.json` (new — shadcn/ui expects this)
- `eslint.config.js`
- `index.html` (change `main.ts` → `main.tsx`)
- `src/main.tsx` (new — minimal React mount)
- `src/globals.css` (new — Tailwind directives + theme vars, replaces `global.css`)
- `src/lib/utils.ts` (new — `cn()` helper)
- `components.json` (new — shadcn/ui config)

**Pattern reference:** `src/main.ts` (current Svelte mount)

**Details:**
- Remove: `svelte`, `@sveltejs/vite-plugin-svelte`, `svelte-eslint-parser`, `eslint-plugin-svelte`, `prettier-plugin-svelte`
- Add: `react`, `react-dom`, `react-router`, `@vitejs/plugin-react-swc`, `tailwindcss`, `@tailwindcss/vite`, `zustand`, `class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, `@types/react`, `@types/react-dom`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `@testing-library/react`, `@testing-library/jest-dom`
- `vite.config.ts`: replace `svelte()` plugin with `react()` from `@vitejs/plugin-react-swc` and `tailwindcss()` from `@tailwindcss/vite`
- `tsconfig.json`: add `"jsx": "react-jsx"`, update `include` to cover `.tsx` files
- `eslint.config.js`: remove svelte rules, add react-hooks and react-refresh plugins
- `src/main.tsx`: `createRoot(document.getElementById('app')!).render(<App />)` — just renders a placeholder `<div>React works</div>`
- Do NOT delete the `.svelte` files yet — they serve as reference

**Checklist:**
- [x] Uninstall Svelte packages
- [x] Install React + Tailwind + shadcn/ui deps + Zustand + react-router
- [x] Update `vite.config.ts`
- [x] Update `tsconfig.json` (add jsx, update include)
- [x] Update `eslint.config.js`
- [x] Create `src/globals.css` with Tailwind directives and theme variables
- [x] Create `src/lib/utils.ts` with `cn()` helper
- [x] Create `components.json` for shadcn/ui
- [x] Create `src/main.tsx` with minimal React render
- [x] Update `index.html` to point to `main.tsx`
- [x] Run `npm run dev` — page loads with placeholder text
- [x] Run `npx tsc --noEmit` — no type errors on new files

**Notes:** Deleted `src/main.ts` (replaced by `main.tsx`, was causing tsc errors from Svelte imports). Fixed `src/vite-env.d.ts` to remove `/// <reference types="svelte" />`. `svelte.config.js` and `.svelte` files kept for reference per plan; they don't affect the build. `npx` must be run via nvm login shell on this WSL setup.

---

### Task 2: Scaffold shadcn/ui primitives

Use the shadcn CLI to add the component primitives. Verify they import without errors.

**Files to create:**
- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/textarea.tsx`
- `src/components/ui/label.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/checkbox.tsx`
- `src/components/ui/card.tsx`
- `src/components/ui/collapsible.tsx`
- `src/components/ui/accordion.tsx`
- `src/components/ui/popover.tsx`
- `src/components/ui/command.tsx`
- `src/components/ui/breadcrumb.tsx`
- `src/components/ui/badge.tsx`

**Details:**
- Run `npx shadcn@latest init` (select New York style, CSS variables)
- Run `npx shadcn@latest add button input textarea label select checkbox card collapsible accordion popover command breadcrumb badge`
- Customize Badge to add `warning`, `success`, and outcome-specific variants matching the current colors
- Customize Button to ensure the `destructive` variant matches current `button.danger` style

**Checklist:**
- [x] Run shadcn init
- [x] Add all 13 components
- [x] Customize Badge variants
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Used `shadcn@4.0.2`. Required `.npmrc` with `legacy-peer-deps=true` due to eslint@10 / eslint-plugin-react-hooks peer conflict. Installed `radix-ui` and `cmdk` as dependencies. 14 component files generated (13 requested + dialog as dependency of command). Fixed missing `import * as React` in `collapsible.tsx`. Added 6 custom Badge variants: warning, success, completed, failed, maxiters, cancelled.

---

### Task 3: Create Zustand store

Implement the `AppStore` with repos and sessions state, Tauri event listener, and periodic sync.

**Files to create:**
- `src/store.ts`

**Pattern reference:** `src/App.svelte` (lines 27–158 — all state declarations, `onMount`, event listener, `syncActiveSession`, `handleRunSession`)

**Details:**
- Translate all `$state()` declarations into Zustand state
- `sessions` and `latestTraces` are `Map<string, T>` — mutations create new Map instances for immutability
- `initialize()` sets up `listen("session-event", ...)`, loads repos, loads latest traces, starts 5-second sync interval. Returns cleanup function.
- `runSession()` translates directly from `handleRunSession` in App.svelte
- `stopSession()` and `reconnectSession()` translate from the corresponding functions
- Repo actions (`loadRepos`, `addLocalRepo`, `addSshRepo`, `updateRepo`) delegate to `repos.ts` functions and update `state.repos`

**Checklist:**
- [x] Create `src/store.ts` with full `AppStore` interface
- [x] Implement `initialize()` with event listener + sync interval
- [x] Implement session actions (run, stop, reconnect)
- [x] Implement repo actions (load, addLocal, addSsh, update)
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Zustand store with `create<AppStore>()`. `initialize()` loads repos, fetches latest traces, subscribes to `session-event` via `listen()`, starts 5-second sync interval, returns cleanup function. Session events handled with immutable Map updates (new Map on every mutation). Error strings extracted with `e instanceof Error ? e.message : String(e)`. Listen cleanup uses promise-based pattern to avoid race conditions on fast unmount. Added `.catch(() => {})` on startup promises for parity with original Svelte code.

---

### Task 4: Create App.tsx with router and store initialization

Set up react-router with all routes and call `store.initialize()` on mount.

**Files to create:**
- `src/App.tsx`

**Pattern reference:** `src/App.svelte` (lines 292–374 — the template section with view switching)

**Details:**
- `BrowserRouter` with `Routes` and `Route` for all 6 paths
- A `Layout` wrapper component that calls `useAppStore(s => s.initialize)` in a `useEffect` (run once on mount, cleanup on unmount)
- Page components can be placeholder `div`s initially — they'll be built in subsequent tasks
- Import `globals.css` here

**Checklist:**
- [x] Create `src/App.tsx` with router and layout
- [x] Store initializes on mount (event listener active)
- [x] All 6 routes render placeholder pages
- [x] Update `src/main.tsx` to render `App`
- [x] Verify `npm run dev` — navigating routes works
- [x] Verify `npx tsc --noEmit` passes

**Notes:** `AppRoutes` exported as named export (router-free) for testability — tests use `MemoryRouter` wrapper. Default export `App` wraps in `BrowserRouter`. `globals.css` imported only in `main.tsx` (not duplicated in App.tsx). Layout uses `Outlet` from react-router. 9 unit tests covering all routes, store init, and cleanup.

---

### Task 5: Breadcrumbs component

Convert the Breadcrumbs component using shadcn/ui `Breadcrumb`.

**Files to create:**
- `src/components/Breadcrumbs.tsx`

**Pattern reference:** `src/Breadcrumbs.svelte`

**Details:**
- Use shadcn `Breadcrumb`, `BreadcrumbList`, `BreadcrumbItem`, `BreadcrumbLink`, `BreadcrumbSeparator`, `BreadcrumbPage`
- Same props: `crumbs: { label: string; onClick?: () => void }[]`
- Clickable crumbs use `BreadcrumbLink` with `onClick`, terminal crumb uses `BreadcrumbPage`

**Checklist:**
- [x] Create `src/components/Breadcrumbs.tsx`
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Uses shadcn/ui Breadcrumb primitives. Crumbs with `onClick` render as `BreadcrumbLink` (with `cursor-pointer`, `role="button"`, `tabIndex={0}`), crumbs without render as `BreadcrumbPage`. Uses `React.Fragment` for keyed iteration (not `<span>`) to maintain valid `<ol>` > `<li>` HTML nesting. 11 unit tests covering empty/single/multiple crumbs, click handlers, separator counts, and terminal crumb behavior.

---

### Task 6: RepoCard component

Convert the RepoCard using shadcn `Card` and `Badge`.

**Files to create:**
- `src/components/RepoCard.tsx`

**Pattern reference:** `src/RepoCard.svelte`

**Details:**
- Use `Card` as the outer container, styled as a clickable button
- Status indicator uses `Badge` with custom variants (`idle`, `running`, `completed`, `failed`, `disconnected`)
- `running` status dot gets pulse animation via Tailwind `animate-pulse`
- `disconnected` gets a blink animation (custom Tailwind keyframe)
- Last trace info (plan name, cost, context %, time ago) rendered the same way
- Branch label rendered below repo path

**Checklist:**
- [x] Create `src/components/RepoCard.tsx`
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Renders as a `<button>` with Tailwind card styles (not shadcn Card `<div>`, which would break button role semantics). Status uses inline-styled dot + uppercase label. Custom `animate-blink` keyframe added to `globals.css` for disconnected status (distinct from `animate-pulse` used for running). 27 unit tests covering rendering, paths (local/SSH), branch display, all 5 statuses, aria-label, click handler, and last trace info (plan filename, cost, context %, time ago).

---

### Task 7: IterationGroup component

Convert the IterationGroup component.

**Files to create:**
- `src/components/IterationGroup.tsx`

**Pattern reference:** `src/IterationGroup.svelte`

**Details:**
- Same props interface: `group`, `expanded`, `onToggle`, `formatTime`, `expandedEvents`, `toggleEvent`, `globalStartIndex`, `repoPath`
- Collapsible iteration header with toggle arrow, title, stats
- Context bar with fill percentage and label
- Event list with expandable detail (tool_input JSON, check output, git sync error)
- Event kind → color mapping via Tailwind text color classes
- Uses `eventEmoji()` and `eventLabel()` from `event-format.ts`

**Checklist:**
- [x] Create `src/components/IterationGroup.tsx`
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Exported as `IterationGroupComponent`. Event kind → color mapping via `eventKindColor` lookup object using Tailwind arbitrary value classes. Context bar uses standard React `style` prop for dynamic width/color. `formatDuration` helper is file-local. 36 unit tests covering header stats, toggle, context bar (color/percentage/cap at 100%), event list (emoji, label, time, click), expandable detail (tool_input JSON, check output, git sync error), and repoPath-relative paths.

---

### Task 8: EventsList component

Convert the EventsList component.

**Files to create:**
- `src/components/EventsList.tsx`

**Pattern reference:** `src/EventsList.svelte`

**Details:**
- `expandedEvents` and `expandedIterations` become `useState<Set<number>>` — toggle by creating new Set
- `autoScroll` logic via `useState` + `useRef` for the scroll container
- `useEffect` to auto-expand latest iteration when live
- `useEffect` to auto-scroll when new events arrive and `autoScroll` is true
- `grouped` computed via `useMemo(() => groupEventsByIteration(events), [events])`
- "Jump to bottom" floating button when `!autoScroll`
- Renders standalone before-events, IterationGroup components, standalone after-events

**Checklist:**
- [x] Create `src/components/EventsList.tsx`
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Named export `EventsList`. Internal state: `expandedEvents`, `expandedIterations` (Set<number>), `autoScroll` (boolean), `lastExpandedIterRef` (ref). Groups events via `useMemo(groupEventsByIteration)`. Computes `iterationGlobalStartIndices` and `afterStartIndex` via `useMemo`. Auto-expands latest iteration when `isLive` via `useEffect`. Auto-scrolls on new events. "Jump to bottom" button when `!autoScroll`. Standalone before/after events rendered with `eventKindColor` Tailwind classes. `formatTime` uses `toLocaleTimeString` with 2-digit h/m/s options. Imports from `event-format.ts` (not `event-display.ts`) for `repoPath` support. 28 unit tests with mocked `IterationGroupComponent`.

---

### Task 9: Home page

Convert HomeView to the Home page component.

**Files to create:**
- `src/pages/Home.tsx`

**Pattern reference:** `src/HomeView.svelte`

**Details:**
- Reads `repos`, `sessions`, `latestTraces` from Zustand store
- Local state for `addMode`, `sshHost`, `sshRemotePath` (these don't need to be global)
- `useBranchInfo(repos)` hook for branch display on cards
- Uses `Breadcrumbs`, `RepoCard`, `Button`, `Input` shadcn components
- `deriveStatus()` function stays the same
- Navigation via `useNavigate()`: `onSelectRepo` → `navigate(/repo/${id})`, `onHistory` → `navigate('/history')`
- Repo grid via Tailwind grid classes: `grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4`

**Checklist:**
- [x] Create `src/pages/Home.tsx`
- [x] Create `src/hooks/useBranchInfo.ts`
- [x] Verify `npm run dev` — home page renders with repo cards
- [x] Verify `npx tsc --noEmit` passes

**Notes:** `Home` is the default export from `src/pages/Home.tsx`. Uses `useBranchInfo(repos)` hook for branch display. Local state for `addMode`, `sshHost`, `sshRemotePath`. `deriveStatus()` matches Svelte logic. Uses shadcn `Button`, `Input`, `Label` plus custom `Breadcrumbs` and `RepoCard`. Race condition protection in `useBranchInfo` via cancelled flag in useEffect cleanup. Error handling on `addLocalRepo`/`addSshRepo` via try/catch. Updated `App.test.tsx` mock to include store fields needed by real Home component. 36 new tests (8 hook + 28 page).

---

### Task 10: RepoDetail page

Convert RepoDetail — the largest component.

**Files to create:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/RepoDetail.svelte`

**Details:**
- Read `repoId` from `useParams()`, find repo from store
- Local state for all settings fields (model, maxIterations, etc.) — synced from repo via `useEffect`
- Settings section: use `Collapsible` (shadcn) instead of `<details>`
- Checks section: use `Accordion` (shadcn) for individual checks
- Git Sync section: use `Collapsible`
- Branch selector: `Popover` + `Command` from shadcn (replaces hand-rolled dropdown)
- Plan section with file input + browse button + preview
- Connection test stepper: custom Tailwind component (no shadcn equivalent)
- Actions: Run/Stop/1-Shot buttons using shadcn `Button` variants
- `EventsList` component for session events
- Trace result section with dl/dt/dd grid
- `useEffect` for branch info refresh on mount and after session completes

**Checklist:**
- [x] Create `src/pages/RepoDetail.tsx`
- [x] Branch selector works with Popover + Command
- [x] Settings/Checks/GitSync collapsibles work
- [x] Connection test stepper renders and updates
- [x] Verify `npm run dev` — full repo detail page functional
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Default export `RepoDetail`. Uses `useParams` for repoId, `useAppStore` for repos/sessions/actions. Local state for all settings fields synced from repo via `useEffect([repo?.id])`. Branch selector uses shadcn `Popover`+`Command` with search filtering, ahead/behind display, and fast-forward button. Settings/Checks/GitSync use `Collapsible` and `Accordion`. Connection test stepper with `listen()` for step events, cleanup via `useRef`. Plan section with file preview via `invoke("read_file_preview")`. Run/Stop/Reconnect/1-Shot action buttons. EventsList integration. Trace result section with dl/dt/dd grid and context color. 48 unit tests covering all sections.

---

### Task 11: History page

Convert HistoryView.

**Files to create:**
- `src/pages/History.tsx`

**Pattern reference:** `src/HistoryView.svelte`

**Details:**
- Optional `repoId` from `useParams()` — controls filtered vs. global view
- Loads repos from store for name display
- Local state: `traces`, `loading`, `error`, `sortField`, `sortDir`
- `useEffect` on mount to `invoke("list_traces", { repoId })`
- `sortedTraces` via `useMemo(() => sortTraces(traces, sortField, sortDir), [traces, sortField, sortDir])`
- Sortable column headers with toggle direction
- Outcome badges using shadcn `Badge` with custom variants
- Navigation: `onSelectRun` → `navigate(/run/${repoId}/${sessionId})`

**Checklist:**
- [x] Create `src/pages/History.tsx`
- [x] Verify sorting works
- [x] Verify navigation to run detail works
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Default export `History`. Uses `useParams` for optional repoId, `useAppStore` for repos. Local state for traces, loading, error, sortField, sortDir. Loads traces via `invoke("list_traces")` in useEffect with cleanup flag. Sorted via `useMemo(sortTraces)`. Column headers are sort buttons with ↓/↑ indicators. Repo column only shown in global view. Outcome badges use shadcn Badge with completed/failed/maxiters/cancelled variants. Breadcrumbs: global shows Home > History; repo-filtered shows Home > RepoName > History (repo crumb navigates to /repo/:repoId). Trace rows navigate to /run/:repoId/:sessionId. 21 unit tests covering loading/error/empty states, breadcrumbs, column headers, sorting, trace rows, outcome badges, and navigation.

---

### Task 12: RunDetail page

Convert RunDetail.

**Files to create:**
- `src/pages/RunDetail.tsx`

**Pattern reference:** `src/RunDetail.svelte`

**Details:**
- `repoId` and `sessionId` from `useParams()`
- `useEffect` on mount to load trace + events via `invoke`
- Copy session ID to clipboard with "Copied!" feedback
- Summary section with dl/dt/dd grid, outcome badge
- `EventsList` for historical events (not live)
- Breadcrumbs: Home → History → Run {sessionId}

**Checklist:**
- [x] Create `src/pages/RunDetail.tsx`
- [x] Verify data loads and displays
- [x] Verify copy-to-clipboard works
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Default export `RunDetail`. Uses `useParams` for repoId and sessionId. Fetches trace + events via `Promise.all(invoke("get_trace"), invoke("get_trace_events"))` with cancelled-flag cleanup. Loading/error/data states. Breadcrumbs: Home (→"/") > History (→"/history") > Run {sessionId} (terminal). Summary dl/dt/dd grid: Outcome (Badge), Failure Reason (conditional), Plan (filename), Iterations, Cost ($X.XXXX), Duration (Xm Xs), Tokens (in/out with toLocaleString), Session ID + Copy button with 1.5s "Copied!" feedback and timer cleanup. EventsList with events and repoPath props (not live). Wired into App.tsx router replacing placeholder. Added `navigator.clipboard` polyfill to test-setup.ts for jsdom. 28 unit tests.

---

### Task 13: OneShot page

Convert OneShotView.

**Files to create:**
- `src/pages/OneShot.tsx`

**Pattern reference:** `src/OneShotView.svelte`

**Details:**
- `repoId` from `useParams()`, repo and session from store
- Form fields: title, prompt, model, merge strategy (radio group)
- Phase indicator with color based on phase state
- Uses `EventsList`, shadcn `Button`, `Input`, `Textarea`, `Label`
- `RadioGroup` from shadcn (add if not yet scaffolded) or plain radio inputs
- `runOneShot` invokes Tauri `run_oneshot` command

**Checklist:**
- [x] Create `src/pages/OneShot.tsx`
- [x] Verify form renders, submit triggers Tauri invoke
- [x] Verify `npx tsc --noEmit` passes

**Notes:** Default export `OneShot`. Uses `useParams` for repoId, `useAppStore` for repos/sessions. Local state for title, prompt, model (defaults to repo.model), mergeStrategy (defaults to "merge_to_main"). Form hidden when running. Phase indicator via `useMemo(getPhaseFromEvents)` with color classes: `text-red-400` for failed, `text-emerald-400` for complete. Run calls `invoke("run_oneshot", buildOneShotArgs(...))`, Stop calls `invoke("stop_session", { repoId })`. EventsList with isLive prop. Error and trace result sections. Wired into App.tsx router replacing placeholder. 53 unit tests covering all sections including invoke rejection handling.

---

### Task 14: Delete Svelte files and old config

Remove all `.svelte` files and Svelte-specific config now that React versions are complete.

**Files to delete:**
- `src/App.svelte`
- `src/HomeView.svelte`
- `src/RepoDetail.svelte`
- `src/RepoCard.svelte`
- `src/EventsList.svelte`
- `src/IterationGroup.svelte`
- `src/Breadcrumbs.svelte`
- `src/HistoryView.svelte`
- `src/RunDetail.svelte`
- `src/OneShotView.svelte`
- `src/global.css` (replaced by `globals.css`)
- `src/main.ts` (replaced by `main.tsx`)
- `src/vite-env.d.ts` (if replaced by updated tsconfig)
- `svelte.config.js` (if it exists)

**Checklist:**
- [x] Delete all `.svelte` files
- [x] Delete `src/global.css` and `src/main.ts`
- [x] Verify `npm run dev` still works
- [x] Verify `npx tsc --noEmit` passes
- [x] Verify `npx eslint .` passes

**Notes:** Deleted 10 `.svelte` files, `src/global.css`, and `svelte.config.js`. `src/main.ts` was already deleted in Task 1. `src/vite-env.d.ts` kept (still provides `vite/client` types). Updated stale `.svelte` comment references in `src/RepoDetail.test.ts` and `e2e/oneshot.test.ts`. Updated `CLAUDE.md` to reflect React tech stack.

---

### Task 15: Update unit tests

Rewrite component-level unit tests for React. Pure TS module tests need no changes.

**Files to modify/create:**
- `src/RepoCard.test.ts` → `src/RepoCard.test.tsx` (or delete if logic was extracted)
- `src/RepoDetail.test.ts` → delete (covered by E2E)
- `src/OneShotView.test.ts` → delete (covered by E2E)

**Pattern reference:** `src/repos.test.ts` (pure TS test pattern — unchanged), `src/RepoCard.test.ts` (current component test)

**Details:**
- Pure TS tests (`repos.test.ts`, `time.test.ts`, `sort.test.ts`, `event-display.test.ts`, `event-format.test.ts`, `iteration-groups.test.ts`, `context-bar.test.ts`, `oneshot-helpers.test.ts`, `types.test.ts`) — no changes
- `RepoCard.test.ts` currently tests pure logic (buildRepoPayload, shouldShowBranch), not Svelte rendering — likely needs minimal changes (just verify it still compiles)
- Add `@testing-library/react` and `@testing-library/jest-dom` to vitest setup if needed
- Vitest config may need `environment: 'jsdom'` for React component tests

**Checklist:**
- [x] Verify all pure TS tests pass: `npm test`
- [x] Update or rewrite component tests that import Svelte
- [x] Configure vitest for jsdom if needed
- [x] All unit tests pass: `npm test`

**Notes:** jsdom and `@testing-library/react` were already configured from earlier tasks. No Svelte imports remained in any test files. Fixed 3 fragile route tests in `App.test.tsx` that used placeholder-era regex assertions — updated to match real component output (`"Repo not found"`, `"Loading..."`). Deleted `src/RepoDetail.test.ts` and `src/OneShotView.test.ts` (inline utility tests superseded by `src/pages/RepoDetail.test.tsx` with 48 tests, `src/pages/OneShot.test.tsx` with 53 tests, and `src/oneshot-helpers.test.ts`). Kept `src/RepoCard.test.ts` (standalone utility function tests for `buildRepoPayload`, `shouldShowBranch`). Final: 24 test files, 668 tests passing.

---

### Task 16: Update E2E tests

Update Playwright E2E tests for React DOM structure and routing.

**Files to modify:**
- `e2e/fixtures.ts` (likely unchanged)
- `e2e/home.test.ts`
- `e2e/breadcrumbs.test.ts`
- `e2e/checks.test.ts`
- `e2e/history.test.ts`
- `e2e/run-detail.test.ts`
- `e2e/oneshot.test.ts`
- `e2e/branch-display.test.ts`
- `e2e/ssh-repo.test.ts`
- `e2e/git-sync.test.ts`

**Pattern reference:** `e2e/fixtures.ts` (Tauri mock injection — unchanged), `e2e/home.test.ts` (current test patterns)

**Details:**
- `fixtures.ts` Tauri IPC mocking is framework-agnostic — no changes expected
- Tests that navigate by clicking UI elements should still work if selectors match
- Tests may need updated selectors if shadcn components use different DOM structure (e.g., Radix portals for popovers)
- Tests that check `<details>` elements need updating for Collapsible/Accordion
- Add route-based navigation where it simplifies test setup (e.g., `page.goto('/repo/abc')`)

**Checklist:**
- [x] Verify `e2e/fixtures.ts` still works
- [x] Update selectors in each E2E test file
- [x] Run `npm run test:e2e` — all tests pass

**Notes:** Added CSS classes to React components as stable E2E test hooks: `.breadcrumbs`, `.toolbar-header`, `.subtitle`, `.settings`, `.checks`, `.git-sync`, `.check-entry`, `.plan-section`, `.branch-chip`/`.warning`, `.branch-dropdown`, `.branch-item`/`.active`, `.branch-search`, `.branch-empty`, `.trace-list`, `.trace-header`, `.trace-row`, `.trace-prompt`, `.trace-plan`, `.trace-badge`, `.summary`, `.form-section`, `.phase-indicator`/`.complete`/`.failed`. Updated all 9 E2E test files: replaced `details.settings`/`details.checks`/`details.git-sync` selectors with `.settings`/`.checks`/`.git-sync`; replaced `summary` element selectors with `[data-slot="collapsible-trigger"]` and `[data-slot="accordion-trigger"]`; replaced `toHaveAttribute("open")` with `toHaveAttribute("data-state", "open")`; replaced `.current` breadcrumb selector with `[aria-current="page"]`; replaced breadcrumb separator `/` text check with `[data-slot="breadcrumb-separator"]`; updated OneShot form selectors for sibling Label+Input pattern; changed `button.branch-item` to `.branch-item` (CommandItem renders as div). Added `<h1>History</h1>` to History page (was missing). Updated 2 unit test files (`App.test.tsx`, `History.test.tsx`) to use `getByRole("heading")` for the new h1. Added `shouldFilter={false}` to branch Command component to prevent double-filtering with external `filteredBranches`. Fixtures unchanged. 113 E2E tests, 668 unit tests all passing.

---

### Task 17: Final verification and cleanup

Full build, lint, format, and manual smoke test.

**Checklist:**
- [x] `npm run dev` — app starts, all pages render
- [x] `npx tsc --noEmit` — no type errors
- [x] `npx eslint .` — no lint errors
- [x] `npx prettier --check .` — formatting clean
- [x] `npm test` — all unit tests pass
- [x] `npm run test:e2e` — all E2E tests pass
- [ ] Manual: add a repo, open repo detail, toggle settings, browse branches
- [x] Remove any leftover Svelte references in comments or config

**Notes:** Fixed 8 ESLint errors: removed unused `container` destructurings in EventsList.test.tsx, removed unused imports (`waitFor` in OneShot.test.tsx, `SessionState` in store.test.ts), replaced `as any` casts with proper type assertions in badge.test.tsx, fixed `return` in `finally` block in store.ts (replaced with `if` guard), added `eslint-disable` block for Playwright fixture `use()` parameter (false positive for react-hooks/rules-of-hooks) in e2e/fixtures.ts. Ran `prettier --write` to format 44 files. Remaining 2 ESLint warnings are expected shadcn/ui patterns (badge.tsx and button.tsx exporting utility functions alongside components). No Svelte references found in source, tests, or config. Manual smoke test left for user. 668 unit tests (24 files), 113 E2E tests all passing.

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Swap dependencies and build config | Done |
| 2 | Scaffold shadcn/ui primitives | Done |
| 3 | Create Zustand store | Done |
| 4 | Create App.tsx with router | Done |
| 5 | Breadcrumbs component | Done |
| 6 | RepoCard component | Done |
| 7 | IterationGroup component | Done |
| 8 | EventsList component | Done |
| 9 | Home page | Done |
| 10 | RepoDetail page | Done |
| 11 | History page | Done |
| 12 | RunDetail page | Done |
| 13 | OneShot page | Done |
| 14 | Delete Svelte files | Done |
| 15 | Update unit tests | Done |
| 16 | Update E2E tests | Done |
| 17 | Final verification and cleanup | Done |
