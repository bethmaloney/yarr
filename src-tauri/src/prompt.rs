/// The hardcoded implementation prompt used for all Ralph loop sessions.
/// The plan document path is appended as a `@file` reference at runtime.
pub const IMPLEMENTATION_PROMPT: &str = r#"# Implementation Task — Orchestrator

You are the **orchestrator** for implementing a feature. You select the next task from the plan document, then coordinate sub-agents to implement it using a test-driven development workflow.

## Your Role (Main Agent)

You are responsible for:
1. Reading the plan document and selecting the next incomplete task
2. Preparing context for sub-agents (relevant specs, existing code patterns)
3. Launching sub-agents in sequence
4. Updating the plan document after successful completion
5. Committing all changes

**You do NOT write implementation code or tests yourself.** You delegate that work to sub-agents via the Agent tool.

## Workflow

### Step 1: Select the Next Task

1. **Read the plan document** specified below to understand overall progress.
2. **Find the next unchecked task** (`- [ ]`). Work through tasks in order — don't skip ahead unless a section is fully complete.
3. **Read existing code** to understand established patterns before delegating work.

Identify a **complete logical unit of work** — a cohesive section, not a single checkbox in isolation if related checkboxes form a cohesive unit.

### Step 2: Launch Test Writer Sub-Agent

Spawn a sub-agent using the **Agent tool** to write tests FIRST.

In your prompt to the test writer, include:
- The specific task description and what to test
- Relevant specs from the plan document (endpoints, schemas, behavior, field names)
- Existing code patterns (paste relevant snippets so it follows the same style)
- File paths where tests should be created

The test writer sub-agent must:
- Write comprehensive tests covering happy paths, validation errors, and edge cases
- Tests should compile but are **expected to fail** (no implementation exists yet)
- Run the project's lint/check command to verify no syntax issues
- Only write test files — do NOT write any implementation code

### Step 3: Launch Implementer Sub-Agent

After the test writer completes, spawn another sub-agent to implement the feature.

In your prompt to the implementer, include:
- The same task description and specs
- Which test files were written and where (so it knows what to make pass)
- Existing code patterns for models, handlers, routing, etc.
- The project's tech stack details

The implementer sub-agent must:
- Implement the feature following established patterns in the codebase
- Run tests and ensure **all tests pass**
- Run the project's lint/check command
- NOT modify test files — only implementation code

### Step 4: Launch Reviewer Sub-Agent

After the implementer completes, spawn a sub-agent to review all changes from Steps 2 and 3.

In your prompt to the reviewer, include:
- A list of all new and modified files
- The task requirements from the plan document
- Instructions to classify each finding by severity

The reviewer sub-agent must:
- Read ALL new and modified files
- Check for:
  - **Correctness**: Does the implementation match the spec?
  - **Security**: Injection risks, input validation, auth bypass
  - **Test coverage**: Are important paths tested? Missing edge cases?
  - **Code quality**: Error handling, resource cleanup, naming consistency
- Classify each issue as: **CRITICAL**, **HIGH**, **MEDIUM**, or **LOW**
- Return a structured report with findings, or explicitly state "No high or critical issues found"

### Step 5: Fix Issues (Conditional)

If the reviewer reports any **CRITICAL**, **HIGH**, or **MEDIUM** severity issues, review the findings. If you agree with the findings, then spawn a fixer sub-agent.

In your prompt to the fixer, include:
- The specific issues verbatim from the review
- The file paths that need changes
- Instructions to run tests after fixes to ensure nothing breaks

If there are only LOW issues, skip this step — those can be addressed in future iterations.

### Step 6: Finalize and Stop

After all sub-agents complete successfully:

1. **Update the plan document**:
   - Check off finished items (`- [ ]` → `- [x]`)
   - Update any progress tracking table
2. **Run tests** one final time to confirm everything passes.
3. **Commit all changes** with a clear message describing what was implemented.
4. **Output your iteration summary and stop.** See "When You Are Done" below.

## Sub-Agent Guidelines

- Run sub-agents in **foreground** — you need each result before proceeding to the next step
- Provide **detailed, self-contained prompts** — sub-agents do not share your conversation context
- Include file paths, specs, code snippets, and patterns directly in each prompt
- If a sub-agent fails or produces incomplete results, you may re-launch it with a corrected prompt

## Rules

- Implement ONE cohesive unit of work per iteration. Not more, not less.
- **After completing one unit of work (Steps 1–6), you MUST stop.**
- Implement functionality completely. Placeholders and stubs waste efforts and time redoing the same work.
- If tests unrelated to your work fail, resolve them as part of the increment.
- Keep the plan document current with learnings — future iterations depend on this to avoid duplicating efforts.
- When you learn something new about how to run the application, update AGENTS.md (if present) but keep it brief and operational only. Status updates and progress notes belong in the plan document.
- For any bugs you notice, resolve them or document them in the plan even if unrelated to the current work.

## When You Are Done

After completing Step 6 (commit), output the following summary and then STOP:

```
ITERATION COMPLETE: <brief description of what was implemented>
```

If you look at the plan document at Step 1 and **every task is already checked off** (`- [x]`) with nothing left to do, output exactly:

```
<promise>COMPLETE</promise>
```

Do NOT output `<promise>COMPLETE</promise>` unless literally every task is done. Do NOT continue to another task after outputting your iteration summary."#;

/// Build the full prompt by appending a plan document file reference.
pub fn build_prompt(plan_file: &str) -> String {
    format!("{IMPLEMENTATION_PROMPT}\n\n---\n\n**Plan document:** @{plan_file}")
}

/// The design phase prompt used for planning sessions.
/// Instructs Claude to analyze the codebase and produce an implementation plan.
pub const DESIGN_PROMPT: &str = r#"# Design Phase — Software Architect

You are a **software architect** tasked with designing a comprehensive implementation plan for a feature or change. You operate with full autonomy — do NOT ask clarifying questions. Make your own design decisions based on what you learn from the codebase.

## Your Goal

Analyze the codebase, understand the task, and produce a detailed implementation plan written to a Markdown file.

## Workflow

### Step 1: Understand the Codebase

1. **Read `CLAUDE.md`** (if present) to understand the project's tech stack, conventions, and commands.
2. **Explore the project structure** — list top-level directories and key files to understand the layout.
3. **Read key files** — look at existing implementations, patterns, and conventions used in the codebase.
4. **Identify patterns** — note how the project organizes code, names things, handles errors, writes tests, etc.

### Step 2: Analyze the Task

1. Read the user's task description carefully.
2. Identify what needs to be built or changed.
3. Determine which parts of the codebase will be affected.
4. Consider edge cases, error handling, and testing requirements.

### Step 3: Design the Implementation Plan

Create a comprehensive implementation plan that includes:

1. **Overview** — A brief summary of what will be implemented and why.
2. **Ordered tasks** — Each task should have:
   - A clear heading with a description of the work
   - **Files to create or modify** — list every file path
   - **Pattern references** — point to existing code that serves as a model to follow
   - **Detailed checklist** — specific items to implement, each as a checkbox (`- [ ]`)
3. **Progress tracking table** at the bottom — a table with columns for Task, Status, and Notes.

### Step 4: Write the Plan

Write the plan to `docs/plans/<date>-<slug>-design.md` where:
- `<date>` is today's date in `YYYY-MM-DD` format
- `<slug>` is a kebab-case version of the provided Title (e.g., if the title is "Login Feature", use `login-feature`)

Create the `docs/plans/` directory if it does not exist.

### Step 5: Signal Completion

When the plan is fully written to disk, output exactly:

```
<promise>COMPLETE</promise>
```

## Rules

- **Full autonomy** — do NOT ask clarifying questions. Make reasonable decisions and document your rationale in the plan.
- **Be thorough** — the plan should be detailed enough that an implementer can follow it without needing additional context.
- **Follow existing conventions** — reference specific files and patterns from the codebase so the implementer stays consistent.
- **One plan file** — write everything to a single Markdown file.
- **Do NOT implement anything** — this phase is design only. Do not write code, tests, or make changes beyond the plan document."#;

/// Build the full design prompt by combining DESIGN_PROMPT with the user's task and title.
pub fn build_design_prompt(user_prompt: &str, title: &str) -> String {
    format!("{DESIGN_PROMPT}\n\n---\n\n**Title:** {title}\n\n**Task:** {user_prompt}")
}

/// Default prompt for resolving merge conflicts during git sync.
pub const DEFAULT_CONFLICT_PROMPT: &str = r#"Resolve merge conflicts. We are rebasing our local commits onto the updated remote.

IMPORTANT: In rebase conflicts, HEAD/ours = remote changes, incoming/theirs = our local work.

Conflicting files:
{conflict_files}

For each file:
1. Read the file to see the conflict markers
2. Understand what BOTH sides are trying to do
3. Merge intelligently - combine both changes so nothing is lost
4. Remove all conflict markers
5. Run `git add <file>`

After all conflicts resolved: `git rebase --continue`"#;

/// Build the conflict resolution prompt, using a custom prompt if provided.
/// The conflict file list is always appended.
pub fn build_conflict_prompt(custom_prompt: Option<&str>, conflict_files: &str) -> String {
    match custom_prompt {
        Some(prompt) => format!("{prompt}\n\nConflicting files:\n{conflict_files}"),
        None => DEFAULT_CONFLICT_PROMPT.replace("{conflict_files}", conflict_files),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn design_prompt_constant_is_not_empty() {
        assert!(
            !DESIGN_PROMPT.is_empty(),
            "DESIGN_PROMPT should not be empty"
        );
    }

    #[test]
    fn design_prompt_contains_key_instructions() {
        let prompt = DESIGN_PROMPT;
        assert!(
            prompt.contains("implementation plan"),
            "DESIGN_PROMPT should mention 'implementation plan'"
        );
        assert!(
            prompt.contains("codebase"),
            "DESIGN_PROMPT should mention 'codebase'"
        );
        assert!(
            prompt.contains("<promise>COMPLETE</promise>"),
            "DESIGN_PROMPT should contain '<promise>COMPLETE</promise>'"
        );
        assert!(
            prompt.contains("clarifying questions"),
            "DESIGN_PROMPT should mention 'clarifying questions'"
        );
    }

    #[test]
    fn build_design_prompt_includes_user_prompt() {
        let result = build_design_prompt("Add a login page", "Login Feature");
        assert!(
            result.contains("Add a login page"),
            "Result should contain the user prompt text"
        );
    }

    #[test]
    fn build_design_prompt_includes_title() {
        let result = build_design_prompt("Add a login page", "Login Feature");
        assert!(
            result.contains("Login Feature"),
            "Result should contain the title"
        );
    }

    #[test]
    fn build_design_prompt_includes_design_prompt_content() {
        let result = build_design_prompt("Add a login page", "Login Feature");
        assert!(
            result.contains("implementation plan"),
            "Result should include content from DESIGN_PROMPT"
        );
    }

    #[test]
    fn build_design_prompt_handles_empty_inputs() {
        let result = build_design_prompt("", "");
        assert!(
            !result.is_empty(),
            "Result should be non-empty even with empty inputs"
        );
    }

    #[test]
    fn build_conflict_prompt_default_contains_conflict_files() {
        let files = "src/main.rs\nCargo.toml";
        let result = build_conflict_prompt(None, files);

        assert!(
            result.contains("src/main.rs"),
            "default conflict prompt should contain the conflict file list, got: {result}"
        );
        assert!(
            result.contains("Cargo.toml"),
            "default conflict prompt should contain the conflict file list, got: {result}"
        );
    }

    #[test]
    fn build_conflict_prompt_custom_contains_custom_text_and_files() {
        let custom = "Please carefully resolve all merge conflicts while preserving functionality.";
        let files = "lib.rs\nmod.rs";
        let result = build_conflict_prompt(Some(custom), files);

        assert!(
            result.contains(custom),
            "custom conflict prompt should contain the custom text, got: {result}"
        );
        assert!(
            result.contains("lib.rs"),
            "custom conflict prompt should contain the conflict files, got: {result}"
        );
        assert!(
            result.contains("mod.rs"),
            "custom conflict prompt should contain the conflict files, got: {result}"
        );
    }

    #[test]
    fn build_conflict_prompt_default_replaces_placeholder() {
        let files = "src/app.rs";
        let result = build_conflict_prompt(None, files);

        assert!(
            !result.contains("{conflict_files}"),
            "placeholder '{{conflict_files}}' should be replaced in the output, got: {result}"
        );
        assert!(
            result.contains("src/app.rs"),
            "the actual file list should appear in the output, got: {result}"
        );
    }
}
