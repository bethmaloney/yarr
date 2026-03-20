# Design: `.yarr.yml` Repo-Level Configuration

## Summary

Add support for a `.yarr.yml` file at the root of any repo to define default Yarr settings. When a repo is added to Yarr or a session starts, the file is read and its values serve as defaults — overridable per-user via the existing settings UI.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Format | YAML (`.yarr.yml`) | Most readable for nested config (checks, env vars, multi-line prompts). Supports comments. |
| Location | Repo root dotfile | Simple, discoverable. No need for a directory yet. |
| Layering | Live merge, UI wins | Three-tier cascade: `hardcoded default → .yarr.yml → UI override` |
| Discovery | Read on every session start | Picks up changes from git pulls automatically |
| Scope | All settings | Maximum flexibility — teams standardize what they want |
| Validation | Toast warning, proceed | A broken file shouldn't block work |
| Export | Yes, export button in UI | Bootstraps the file from a working setup |

## File Structure

```yaml
# .yarr.yml — Yarr defaults for this repo
model: opus
effortLevel: high
designEffortLevel: high
maxIterations: 40
completionSignal: "ALL TODO ITEMS COMPLETE"
createBranch: true
autoFetch: true
plansDir: docs/plans/
movePlansToCompleted: true
designPromptFile: .yarr/design-prompt.md
implementationPromptFile: .yarr/implementation-prompt.md

env:
  NODE_ENV: test
  LOG_LEVEL: debug

checks:
  - name: typecheck
    command: npx tsc --noEmit
    when: each_iteration
    timeoutSecs: 120
    maxRetries: 2
  - name: test
    command: npm test
    when: post_completion
    timeoutSecs: 600
    maxRetries: 3
    prompt: "Fix the failing tests. Output:\n{{output}}"
    model: sonnet

gitSync:
  enabled: true
  model: sonnet
  maxPushRetries: 3
  conflictPrompt: "Resolve merge conflicts preserving our changes"
```

Field names use camelCase matching the existing TypeScript `RepoConfig` types. Every field is optional — include only what you want to standardize.

## Three-Tier Merge

```
hardcoded default → .yarr.yml → UI override
```

### Sparse RepoConfig

All `RepoConfig` fields (except `type`, `id`, `path`, `name`) become optional. A missing/undefined field means "not explicitly set by the user." When adding a new repo, `repos.json` stores only the identity fields:

```typescript
type RepoConfig = {
  type: "local" | "ssh";
  id: string;
  path: string;
  name: string;
  // Everything below is optional — only present when user explicitly sets it
  model?: string;
  effortLevel?: string;
  maxIterations?: number;
  completionSignal?: string;
  createBranch?: boolean;
  autoFetch?: boolean;
  plansDir?: string;
  movePlansToCompleted?: boolean;
  designPromptFile?: string;
  implementationPromptFile?: string;
  envVars?: Record<string, string>;
  checks?: Check[];
  gitSync?: GitSyncConfig;
  designEffortLevel?: string;
};
```

### Resolution Function

```typescript
const DEFAULTS = { model: "opus", maxIterations: 40, effortLevel: "medium", ... };

function resolve<T>(override?: T, yarrYml?: T, fallback: T): { value: T; source: "override" | "yarr-yml" | "default" } {
  if (override !== undefined) return { value: override, source: "override" };
  if (yarrYml !== undefined) return { value: yarrYml, source: "yarr-yml" };
  return { value: fallback, source: "default" };
}
```

## Backend

### Reading `.yarr.yml`

On session start, the IPC handler reads `.yarr.yml` via `RuntimeProvider` (required for WSL/SSH cross-platform support):

1. `runtime.read_file(repo_path.join(".yarr.yml"))`
2. File doesn't exist → proceed with no overrides (not an error)
3. File exists → parse with `serde_yaml` into `YarrRepoConfig`
4. Parse fails → `tracing::warn!` with error, emit frontend event for toast, proceed without file

### YarrRepoConfig Struct

```rust
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YarrRepoConfig {
    pub model: Option<String>,
    pub effort_level: Option<String>,
    pub design_effort_level: Option<String>,
    pub max_iterations: Option<u32>,
    pub completion_signal: Option<String>,
    pub create_branch: Option<bool>,
    pub auto_fetch: Option<bool>,
    pub plans_dir: Option<String>,
    pub move_plans_to_completed: Option<bool>,
    pub design_prompt_file: Option<String>,
    pub implementation_prompt_file: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub checks: Option<Vec<Check>>,
    pub git_sync: Option<GitSyncConfig>,
}
```

### Merge in IPC Handler

The frontend sends sparse UI overrides. The backend reads `.yarr.yml`, applies the three-tier merge, and produces the final `SessionConfig`. The frontend doesn't need the merge result — it only sends what the user has explicitly set.

### Frontend IPC for Settings UI

A new `read_yarr_config` IPC command returns the parsed `YarrRepoConfig` (or `null` + error string). Called when the settings sheet opens so the UI can show source indicators.

## UI Design

### Source Indicators

Each form field label shows a small inline badge indicating the value source:

| Source | Indicator | Style |
|--------|-----------|-------|
| Hardcoded default | No badge | Clean, no extra UI |
| `.yarr.yml` | `repo config` | `text-xs font-mono text-info` |
| User override | `custom` + reset `X` button | `text-xs font-mono text-primary` |

The reset button (`X`, `size-3.5`, `text-muted-foreground hover:text-foreground`) removes the override from `repos.json`, letting the value fall back to `.yarr.yml` or default.

```jsx
<Label className="flex flex-col gap-1">
  <span className="text-sm text-muted-foreground flex items-center gap-2">
    Model
    {source === "yarr-yml" && (
      <span className="text-xs font-mono text-info">repo config</span>
    )}
    {source === "override" && (
      <>
        <span className="text-xs font-mono text-primary">custom</span>
        <button onClick={onReset} className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" />
        </button>
      </>
    )}
  </span>
  <Input value={effectiveValue} ... />
</Label>
```

### Config Status Banner

At the top of the settings sheet header, a single-line strip indicates `.yarr.yml` status:

```jsx
{/* Loaded */}
<div className="flex items-center gap-2 text-xs font-mono text-info bg-card-inset rounded-md px-3 py-1.5">
  <FileText className="size-3.5" />
  .yarr.yml loaded — 12 fields inherited
</div>

{/* Not found */}
<div className="flex items-center gap-2 text-xs font-mono text-muted-foreground bg-card-inset rounded-md px-3 py-1.5">
  <FileText className="size-3.5" />
  No .yarr.yml found
</div>

{/* Parse error */}
<div className="flex items-center gap-2 text-xs font-mono text-warning bg-card-inset rounded-md px-3 py-1.5">
  <AlertTriangle className="size-3.5" />
  .yarr.yml parse error — using UI settings only
</div>
```

### Export Button

Added to `SheetFooter` alongside Save/Cancel:

```jsx
<Button variant="outline" size="sm" onClick={handleExport} disabled={session.running}>
  <Download className="size-4" />
  Export .yarr.yml
</Button>
```

Exports the **effective config** (merged result), omitting fields that match hardcoded defaults to keep the file minimal. Uses a Tauri IPC command to write the file, then shows `toast.success(".yarr.yml written to repo root")`.

## Edge Cases

- **`.yarr.yml` deleted mid-use**: next session falls through to defaults for non-overridden fields. No error.
- **Multiple Yarr instances, same repo**: each has its own `repos.json` overrides, sharing the same `.yarr.yml`. Works naturally.
- **Checks and env vars**: no "default" to compare against — empty array/object is the default, any content is explicit.
- **`.yarr.yml` updated via git pull**: picked up on next session start automatically.

---

## Implementation Plan

### Task 1: Add serde_yaml and create YarrRepoConfig struct

Create the Rust struct for parsing `.yarr.yml` files with serde, and add unit tests for parsing.

**Files to create/modify:**
- `src-tauri/Cargo.toml`
- `src-tauri/src/yarr_config.rs` (new)
- `src-tauri/src/main.rs` or `lib.rs` (add `mod yarr_config`)

**Pattern reference:** `src-tauri/src/session.rs` — existing `Check` and `GitSyncConfig` structs with serde derives

**Details:**
- Add `serde_yaml = "0.9"` to `[dependencies]` in Cargo.toml
- Create `YarrRepoConfig` struct with all `Option<T>` fields, `#[serde(rename_all = "camelCase")]`
- Reuse existing `Check` and `GitSyncConfig` types from `session.rs`
- Add a `parse(yaml: &str) -> Result<YarrRepoConfig>` function
- Handle the `env` field as `Option<HashMap<String, String>>`

**Checklist:**
- [x] Add `serde_yaml` dependency to Cargo.toml
- [x] Create `yarr_config.rs` with `YarrRepoConfig` struct
- [x] Add `parse()` function
- [x] Add `mod yarr_config` to lib.rs
- [x] Add unit tests: valid YAML, partial YAML, empty file, malformed YAML, unknown fields ignored
- [x] `cargo check && cargo test`

---

### Task 2: Add `read_yarr_config` IPC command

Backend command for the frontend to read and parse `.yarr.yml` from a repo, used by the settings sheet to show source indicators.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** `src-tauri/src/lib.rs:1586-1611` — `export_default_prompt` command (reads files via RuntimeProvider)

**Details:**
- Accepts `repo: RepoType` parameter
- Builds runtime via existing `build_runtime` helper
- Calls `runtime.read_file(".yarr.yml", &working_dir)`
- If file not found → return `Ok(None)`
- If file found but parse fails → return `Ok(None)` + include error string in a wrapper struct
- If file found and parsed → return `Ok(Some(YarrRepoConfig))`
- Return type: `Result<YarrConfigResult, String>` where `YarrConfigResult = { config: Option<YarrRepoConfig>, error: Option<String> }`

**Checklist:**
- [x] Define `YarrConfigResult` response struct with `Serialize`
- [x] Add `read_yarr_config` command function
- [x] Register in `tauri::generate_handler![]`
- [x] `cargo check`

---

### Task 3: Add `export_yarr_config` IPC command

Backend command to write a `.yarr.yml` file to a repo root from the settings UI.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/yarr_config.rs`

**Pattern reference:** `src-tauri/src/lib.rs:1586-1611` — `export_default_prompt` (writes files via RuntimeProvider using base64 encoding)

**Details:**
- Accepts the effective config as a `YarrRepoConfig` + `repo: RepoType`
- Add `Serialize` derive to `YarrRepoConfig`
- Serialize to YAML string with `serde_yaml::to_string()`
- Add a header comment: `# .yarr.yml — Yarr defaults for this repo\n# See https://github.com/... for documentation\n\n`
- Write via `runtime.run_command()` using the base64 encode/decode pattern
- Return `Ok(())` on success

**Checklist:**
- [x] Add `Serialize` derive to `YarrRepoConfig`
- [x] Add serialization helper in `yarr_config.rs` that produces clean YAML (skip `None` fields)
- [x] Add `export_yarr_config` IPC command in lib.rs
- [x] Register in `tauri::generate_handler![]`
- [x] `cargo check`

---

### Task 4: Create DEFAULTS constant, resolve utility, and YarrYmlConfig type

Frontend foundation for three-tier merge: the defaults, the resolution function, and the TypeScript type matching the Rust struct.

**Files to create/modify:**
- `src/config.ts` (new)

**Pattern reference:** `src/repos.ts:65-88` — current defaults embedded in `addLocalRepo`

**Details:**
- Extract hardcoded defaults from `addLocalRepo`/`addSshRepo` into a `DEFAULTS` const
- Define `YarrYmlConfig` type mirroring `YarrRepoConfig` (all optional fields)
- Define `ConfigSource = "override" | "yarr-yml" | "default"`
- Define `Resolved<T> = { value: T; source: ConfigSource }`
- Implement `resolve<T>(override?: T, yarrYml?: T, fallback: T): Resolved<T>`
- Implement `resolveConfig(repo, yarrYml, defaults)` returning a full resolved config object with sources

**Checklist:**
- [x] Create `src/config.ts`
- [x] Define `DEFAULTS` constant
- [x] Define `YarrYmlConfig` type
- [x] Define `ConfigSource`, `Resolved<T>` types
- [x] Implement `resolve()` and `resolveConfig()`
- [x] Add unit tests in `src/config.test.ts`: override wins, yarr-yml wins, default fallback, undefined handling
- [x] `npx tsc --noEmit && npm test`

---

### Task 5: Make RepoConfig sparse

Change `model`, `maxIterations`, and `completionSignal` from required to optional in the TypeScript types. Update repo creation to store only identity fields.

**Files to modify:**
- `src/repos.ts`
- `src/types.ts` (if relevant type definitions live here)

**Pattern reference:** `src/repos.ts:6-25` — current `LocalRepoConfig` type

**Details:**
- Make `model`, `maxIterations`, `completionSignal` optional (add `?`) in both `LocalRepoConfig` and `SshRepoConfig`
- Update `addLocalRepo` to only store `{ type, id, path, name }`
- Update `addSshRepo` to only store `{ type, id, sshHost, remotePath, name }`
- Fix any TypeScript errors from the optionality change — callers that assume required fields need `?? DEFAULTS.x` or to use `resolveConfig()`

**Checklist:**
- [x] Update `LocalRepoConfig` type — make `model`, `maxIterations`, `completionSignal` optional
- [x] Update `SshRepoConfig` type — same changes
- [x] Update `addLocalRepo` to store sparse config
- [x] Update `addSshRepo` to store sparse config
- [x] Fix TypeScript compilation errors throughout codebase
- [x] `npx tsc --noEmit`

---

### Task 6: Backend three-tier merge in `run_session`

Update the `run_session` IPC handler to accept sparse frontend params, read `.yarr.yml`, and merge.

**Files to modify:**
- `src-tauri/src/lib.rs`
- `src-tauri/src/yarr_config.rs`

**Pattern reference:** `src-tauri/src/lib.rs:79-94` — current `run_session` signature

**Details:**
- Change `model: String` → `model: Option<String>`, `max_iterations: u32` → `max_iterations: Option<u32>`, `completion_signal: String` → `completion_signal: Option<String>`, `create_branch: bool` → `create_branch: Option<bool>`
- After building runtime, call a shared `read_yarr_config_from_repo()` helper that reads + parses `.yarr.yml` (returning `YarrRepoConfig::default()` on missing/error, logging warnings)
- Add a `merge()` method or function in `yarr_config.rs`: takes `(frontend_overrides, yarr_config, defaults) → resolved values`
- Use merged values to build `SessionConfig`
- Emit `yarr-config-warning` event to frontend if parse fails (for toast)

**Checklist:**
- [x] Add `read_yarr_config_from_repo()` helper in `yarr_config.rs`
- [x] Add merge/resolve helper in `yarr_config.rs`
- [x] Update `run_session` parameter types to optional
- [x] Read `.yarr.yml` and merge before building `SessionConfig`
- [x] Emit warning event on parse failure
- [x] `cargo check && cargo test`

---

### Task 7: Backend three-tier merge in `run_oneshot` and `resume_oneshot`

Apply the same merge pattern to the one-shot IPC handlers.

**Files to modify:**
- `src-tauri/src/lib.rs`

**Pattern reference:** Task 6 — the `run_session` changes

**Details:**
- Update `run_oneshot` params: `model`, `max_iterations`, `completion_signal` → `Option`
- Update `resume_oneshot` params similarly
- Reuse `read_yarr_config_from_repo()` and merge helper from Task 6
- Same warning event emission pattern

**Checklist:**
- [x] Update `run_oneshot` parameter types to optional
- [x] Add `.yarr.yml` read + merge to `run_oneshot` handler
- [x] Update `resume_oneshot` parameter types to optional
- [x] Add `.yarr.yml` read + merge to `resume_oneshot` handler
- [x] `cargo check && cargo test`

---

### Task 8: Update store.ts to send sparse config

Update the frontend store to send only user-overridden fields (not defaults) to the backend IPC calls.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:732` — current `runOneShot` invocation with all fields

**Details:**
- `runSession`: send `repo.model` (which is now `undefined` if not overridden) instead of always sending a value
- `runOneShot`: same — pass through optional fields, let backend merge
- `resumeOneShot`: same pattern
- For fields that were previously required by the IPC, pass `null` when undefined (Tauri maps null to `None` in Rust)

**Checklist:**
- [x] Update `runSession` IPC call to pass optional fields
- [x] Update `runOneShot` IPC call to pass optional fields
- [x] Update `resumeOneShot` IPC call to pass optional fields
- [x] `npx tsc --noEmit`

---

### Task 9: Create useYarrConfig hook

Frontend hook that calls the `read_yarr_config` IPC command and provides the parsed config to the settings UI.

**Files to create:**
- `src/hooks/useYarrConfig.ts` (new)

**Pattern reference:** `src/store.ts:82-84` — existing IPC invoke pattern

**Details:**
- `useYarrConfig(repo: RepoConfig | null)` hook
- Calls `invoke<YarrConfigResult>("read_yarr_config", { repo })` on mount and when repo changes
- Returns `{ config: YarrYmlConfig | null, error: string | null, loading: boolean, refresh: () => void }`
- Show toast on parse error via the `error` field
- **Note:** The Rust `YarrRepoConfig` serializes the `env` field as `"env"` in JSON (camelCase rename doesn't change single-word fields), but the frontend `RepoConfig` uses `envVars`. The hook must map `env` → `envVars` when converting the IPC response to `YarrYmlConfig`.

**Checklist:**
- [x] Create `src/hooks/useYarrConfig.ts`
- [x] Implement the hook with loading/error/config state
- [x] `npx tsc --noEmit`

---

### Task 10: Create ConfigSourceBadge component

Reusable component for showing source indicators on settings fields.

**Files to create:**
- `src/components/ConfigSourceBadge.tsx` (new)

**Pattern reference:** `design_system.md` — typography and color tokens; `src/pages/RepoDetail.tsx` — existing label patterns

**Details:**
- Props: `source: ConfigSource`, `onReset?: () => void`
- When `source === "default"` → render nothing
- When `source === "yarr-yml"` → render `<span className="text-xs font-mono text-info">repo config</span>`
- When `source === "override"` → render `custom` badge + `X` reset button
- Reset button: `size-3.5`, `text-muted-foreground hover:text-foreground transition-colors duration-150`

**Checklist:**
- [x] Create `ConfigSourceBadge.tsx`
- [x] Handle all three source states
- [x] Ensure accessible: reset button has `aria-label="Reset to default"`
- [x] `npx tsc --noEmit`

---

### Task 11: Add config status banner to settings sheet

Show the `.yarr.yml` status at the top of the settings sheet header.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — existing `SheetHeader` area

**Details:**
- Call `useYarrConfig(repo)` at the top of the settings sheet section
- Add the status banner div below `SheetDescription` inside `SheetHeader`
- Three states: loaded (text-info), not found (text-muted-foreground), parse error (text-warning)
- Show field count: count non-undefined fields in `yarrConfig`
- Uses `FileText` and `AlertTriangle` icons from lucide-react

**Checklist:**
- [x] Wire `useYarrConfig` into RepoDetail
- [x] Add status banner JSX in SheetHeader
- [x] Handle all three states with correct styling
- [x] `npx tsc --noEmit`

---

### Task 12: Wire source indicators to settings fields

Update the settings sheet form to show `ConfigSourceBadge` on every field, using the resolve utility for effective values and source tracking.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx:110-127` — current useState initializations; `src/pages/RepoDetail.tsx:186-214` — current useEffect sync

**Details:**
- Compute resolved config via `resolveConfig(repo, yarrConfig, DEFAULTS)` in a `useMemo`
- Update `useEffect` sync: initialize each field from `resolved.field.value` instead of `repo.field ?? default`
- Track which fields the user has explicitly changed during this edit session (local `Set<string>` state)
- When user changes a field → mark it as overridden
- Add `ConfigSourceBadge` to each label span with `source={resolved.field.source}` and `onReset` handler
- Reset handler: clears the local state for that field back to the resolved non-override value

**Checklist:**
- [x] Import `resolveConfig`, `DEFAULTS`, `ConfigSourceBadge`
- [x] Add `useMemo` for resolved config
- [x] Update useEffect to initialize from resolved values
- [x] Add `ConfigSourceBadge` to model, effortLevel, maxIterations, completionSignal fields
- [x] Add `ConfigSourceBadge` to createBranch, autoFetch, plansDir, movePlansToCompleted fields
- [x] Add `ConfigSourceBadge` to designPromptFile, implementationPromptFile fields
- [x] Add `ConfigSourceBadge` to checks, envVars, gitSync fields
- [x] `npx tsc --noEmit`

---

### Task 13: Update save handler for sparse storage

Change the save handler to only persist fields that differ from the `.yarr.yml` / default value, and handle field reset.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx:419-445` — current `saveSettings()` function

**Details:**
- When saving, compare each field against the resolved `.yarr.yml` / default value
- If the user's value matches the `.yarr.yml` value or default → omit it from the saved repo (store `undefined`)
- If the user explicitly changed it → include it
- Track overrides: maintain a `dirtyFields: Set<string>` — fields go in only if they're in this set
- Reset button removes field from `dirtyFields` and resets the form value to the resolved fallback

**Checklist:**
- [x] Add `dirtyFields` state tracking
- [x] Update `onChange` handlers to mark fields dirty
- [x] Update `saveSettings()` to only include dirty fields in the repo update
- [x] Implement reset handler that clears field from dirty set
- [x] `npx tsc --noEmit`

---

### Task 14: Add export button to settings sheet footer

Add the "Export .yarr.yml" button that writes the effective config to the repo root.

**Files to modify:**
- `src/pages/RepoDetail.tsx`

**Pattern reference:** `src/pages/RepoDetail.tsx` — existing `SheetFooter` with Save/Cancel buttons

**Details:**
- Add `Button variant="outline" size="sm"` with `Download` icon to SheetFooter
- On click: compute effective config (merged), strip defaults, call `invoke("export_yarr_config", { repo, config })`
- Show `toast.success(".yarr.yml written to repo root")` on success
- Show `toast.error(errorMessage)` on failure
- Disabled during running session
- After export, call `yarrConfig.refresh()` to re-read the file

**Checklist:**
- [x] Add export button JSX in SheetFooter
- [x] Implement `handleExport` function
- [x] Call IPC with effective config
- [x] Toast feedback on success/failure
- [x] Refresh yarrConfig after export
- [x] `npx tsc --noEmit`

---

### Task 15: Frontend event listener for config warnings

Listen for `yarr-config-warning` events from the backend and show toast warnings when `.yarr.yml` fails to parse during session start.

**Files to modify:**
- `src/store.ts`

**Pattern reference:** `src/store.ts:341-372` — existing `session-event` listener pattern

**Details:**
- Add a `listen("yarr-config-warning", ...)` in the `initialize()` function
- Event payload: `{ repo_id: string, error: string }`
- Show `toast.warning(\`.yarr.yml: ${error}\`)`
- Add cleanup in the returned cleanup function

**Checklist:**
- [ ] Add event listener in `initialize()`
- [ ] Show toast warning with error message
- [ ] Add cleanup
- [ ] `npx tsc --noEmit`

---

### Task 16: Rust unit tests for merge logic

Test the three-tier merge and `.yarr.yml` parsing edge cases.

**Files to modify:**
- `src-tauri/src/yarr_config.rs`

**Pattern reference:** existing `#[cfg(test)]` modules in `src-tauri/src/`

**Details:**
- Test parse with all fields present
- Test parse with only some fields (partial config)
- Test parse with empty string → default struct
- Test parse with invalid YAML → error
- Test parse with unknown fields → ignored (serde default behavior)
- Test merge: frontend override wins over yarr-yml
- Test merge: yarr-yml wins over default when no frontend override
- Test merge: default used when neither frontend nor yarr-yml set

**Checklist:**
- [ ] Add `#[cfg(test)] mod tests` in `yarr_config.rs`
- [ ] Test parsing: full, partial, empty, invalid, unknown fields
- [ ] Test merge: all three tiers
- [ ] `cargo test`

---

### Task 17: Frontend unit tests for config resolution

Test the resolve utility and DEFAULTS.

**Files to create:**
- `src/config.test.ts` (new, or extend if created in Task 4)

**Pattern reference:** `src/*.test.ts` — existing Vitest test files

**Details:**
- Test `resolve()`: override wins, yarr-yml wins, default fallback
- Test `resolve()`: undefined vs null handling
- Test `resolveConfig()`: full merge with mixed sources
- Test DEFAULTS has all expected fields

**Checklist:**
- [ ] Write tests for `resolve()`
- [ ] Write tests for `resolveConfig()`
- [ ] Write tests for DEFAULTS completeness
- [ ] `npm test`

---

### Progress Tracking

| Task | Description | Status |
|------|-------------|--------|
| 1 | Add serde_yaml + YarrRepoConfig struct | Done |
| 2 | read_yarr_config IPC command | Done |
| 3 | export_yarr_config IPC command | Done |
| 4 | DEFAULTS, resolve utility, YarrYmlConfig type | Done |
| 5 | Make RepoConfig sparse | Done |
| 6 | Backend merge in run_session | Done |
| 7 | Backend merge in run_oneshot + resume_oneshot | Done |
| 8 | Store.ts sends sparse config | Done |
| 9 | useYarrConfig hook | Done |
| 10 | ConfigSourceBadge component | Done |
| 11 | Config status banner in settings sheet | Done |
| 12 | Wire source indicators to settings fields | Done |
| 13 | Update save handler for sparse storage | Done |
| 14 | Export button in settings sheet | Done |
| 15 | Frontend event listener for config warnings | Not Started |
| 16 | Rust unit tests for merge logic | Not Started |
| 17 | Frontend unit tests for config resolution | Not Started |
