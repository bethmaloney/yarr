# File Picker & Recent Paths — Design

Replace plain text inputs for repo path and prompt file with native OS file/folder pickers and a recent paths dropdown, persisted across app restarts.

## Scope

- Native OS dialogs for browsing (folder picker for repo, file picker for prompt)
- Recent paths dropdown (last 5 per field) stored via Tauri store plugin
- Text inputs remain editable for manual/paste entry
- No Rust command changes — purely plugin + frontend work

## Architecture

Two Tauri v2 plugins:

- **`tauri-plugin-dialog`** — native OS file/folder picker. JS API `open()` with `directory: true` for repo, file filters for prompt.
- **`tauri-plugin-store`** — persistent key-value store (JSON file in app data dir). Stores recent paths arrays.

## UI Layout

Each path input becomes a row:

```
[recent paths dropdown v] [path text input              ] [Browse]
```

- **Dropdown**: shows last 5 paths for that field. Hidden when no recents exist.
- **Browse button**: opens native OS dialog (folder for repo, file for prompt).
- **Text input**: stays editable for power-user pasting. Shows full path after pick.

## Dialog Configuration

- **Repo path**: `open({ directory: true, title: "Select repository" })`
- **Prompt file**: `open({ filters: [{ name: "Markdown", extensions: ["md"] }, { name: "All", extensions: ["*"] }], title: "Select prompt file" })`

Both return `string | null` (null on cancel).

## Store Schema

Single store file `recents.json`:

```json
{
  "recentRepoPaths": ["/home/beth/repos/yarr", "/home/beth/repos/other"],
  "recentPromptFiles": ["/home/beth/repos/yarr/scripts/PROMPT.md"]
}
```

- Arrays capped at 5 entries
- Deduped (new entry pushed to front, existing duplicate removed)
- Updated on successful `runSession()` call, not on pick — only paths that led to a real session get saved

## Plugin Wiring

### Rust (`src-tauri/Cargo.toml`)

```toml
tauri-plugin-dialog = "2"
tauri-plugin-store = "2"
```

### Rust (`src-tauri/src/lib.rs`)

```rust
tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_store::Builder::default().build())
    .invoke_handler(...)
```

### JS (`ui/package.json`)

```json
"@tauri-apps/plugin-dialog": "^2",
"@tauri-apps/plugin-store": "^2"
```

### Capabilities (`src-tauri/capabilities/default.json`)

Add `"dialog:default"` and `"store:default"` to permissions array.

## Behavior Details

- Prompt file picker returns absolute paths; manual entry still accepts relative (resolved by Rust backend against repo path)
- If the store file doesn't exist yet, treat as empty arrays (no error)
- Dropdown only renders when the recents array is non-empty

---

## Implementation Plan

### Task 1: Add Tauri dialog and store plugins (Rust side)

Add both plugin crates as dependencies and register them in the Tauri builder.

**Files to modify:** `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/capabilities/default.json`
**Pattern reference:** existing plugin-less builder in `src-tauri/src/lib.rs:82-87`

**Details:**
- Add `tauri-plugin-dialog = "2"` and `tauri-plugin-store = "2"` to `[dependencies]`
- Chain `.plugin(tauri_plugin_dialog::init())` and `.plugin(tauri_plugin_store::Builder::default().build())` before `.invoke_handler()`
- Add `"dialog:default"` and `"store:default"` to capabilities permissions array

**Checklist:**
- [x] Add crate dependencies to Cargo.toml
- [x] Register plugins in lib.rs builder
- [x] Add permissions to capabilities/default.json
- [x] Verify: `cd src-tauri && cargo check`

---

### Task 2: Add JS plugin packages

Install the frontend npm packages for dialog and store plugins.

**Files to modify:** `ui/package.json`

**Details:**
- Add `@tauri-apps/plugin-dialog` and `@tauri-apps/plugin-store` as dependencies
- Run `npm install` in `ui/`

**Checklist:**
- [x] Add packages to package.json dependencies
- [x] Run npm install
- [x] Verify: imports resolve (npm install succeeded)

---

### Task 3: Add recents store helper

Create a small TypeScript module that wraps the store plugin for loading/saving recent paths.

**Files to create:** `src/recents.ts`
**Pattern reference:** `@tauri-apps/plugin-store` LazyStore API

**Details:**
- Export `loadRecents()` → `{ repoPaths: string[], promptFiles: string[] }`
- Export `saveRecent(key: "repoPaths" | "promptFiles", path: string)` → pushes to front, dedupes, caps at 5, persists
- Use `LazyStore` from the store plugin — auto-creates file on first write
- Store file name: `recents.json`

**Checklist:**
- [ ] Create recents.ts with load/save functions
- [ ] Handle missing store gracefully (empty arrays)
- [ ] Verify: `cd ui && npx tsc --noEmit`

---

### Task 4: Update App.svelte with Browse buttons and recents dropdowns

Wire up the dialog pickers and recents dropdowns into the existing form.

**Files to modify:** `ui/src/App.svelte`
**Pattern reference:** existing form at `ui/src/App.svelte:97-114`

**Details:**
- Import `open` from `@tauri-apps/plugin-dialog`
- Import `loadRecents`, `saveRecent` from `./recents`
- Add state: `recentRepoPaths` and `recentPromptFiles` (string arrays)
- On mount: call `loadRecents()` to populate dropdown state
- Add `browseRepo()` function: calls `open({ directory: true })`, sets `repoPath` on success
- Add `browsePrompt()` function: calls `open({ filters: [...] })`, sets `promptFile` on success
- Each form row: optional recents `<select>` (hidden when empty) + existing `<input>` + `<button>` Browse
- On successful `runSession()`: call `saveRecent()` for both paths, refresh dropdown state
- Style: Browse button matches secondary button style; dropdown styled to match dark theme

**Checklist:**
- [ ] Add dialog imports and browse functions
- [ ] Add recents state and load on mount
- [ ] Add Browse buttons to both input rows
- [ ] Add recents dropdowns (conditional on non-empty)
- [ ] Save recents on successful run
- [ ] Style new elements to match existing theme
- [ ] Verify: manual test with `cd src-tauri && cargo tauri dev`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add Tauri dialog and store plugins (Rust side) | Done |
| 2 | Add JS plugin packages | Done |
| 3 | Add recents store helper | Not Started |
| 4 | Update App.svelte with Browse buttons and recents dropdowns | Not Started |
