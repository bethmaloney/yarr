use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use tokio_util::sync::CancellationToken;

use crate::output::StreamEvent;
use crate::prompt;
use crate::runtime::{ClaudeInvocation, RuntimeProvider};
use crate::session::{AbortRegistry, OnSessionEvent, SessionEvent};
use crate::trace::{SessionOutcome, SessionTrace, TraceCollector};

/// Strategy for integrating 1-shot work back into the repository.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeStrategy {
    MergeToMain,
    Branch,
}

/// Configuration for a 1-shot autonomous implementation session.
#[derive(Debug, Clone)]
pub struct OneShotConfig {
    pub repo_id: String,
    pub repo_path: PathBuf,
    pub title: String,
    pub prompt: String,
    pub model: String,
    pub merge_strategy: MergeStrategy,
    pub env_vars: HashMap<String, String>,
}

/// Convert a title into a URL-safe slug.
///
/// - Lowercase
/// - Replace non-alphanumeric chars with hyphens
/// - Collapse multiple hyphens
/// - Trim leading/trailing hyphens
/// - Truncate to 50 chars
pub fn slugify(title: &str) -> String {
    let lowered = title.to_lowercase();
    let mut result = String::new();
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            result.push(ch);
        } else {
            result.push('-');
        }
    }
    // Collapse consecutive hyphens
    let mut collapsed = String::new();
    let mut prev_hyphen = false;
    for ch in result.chars() {
        if ch == '-' {
            if !prev_hyphen {
                collapsed.push('-');
            }
            prev_hyphen = true;
        } else {
            collapsed.push(ch);
            prev_hyphen = false;
        }
    }
    // Trim leading/trailing hyphens
    let trimmed = collapsed.trim_matches('-').to_string();
    // Truncate to 50 chars
    if trimmed.len() <= 50 {
        trimmed
    } else {
        let truncated = &trimmed[..50];
        truncated.trim_end_matches('-').to_string()
    }
}

/// Generate a short identifier (first 6 chars of a UUID v4).
pub fn generate_short_id() -> String {
    let uuid = uuid::Uuid::new_v4().to_string().replace('-', "");
    uuid[..6].to_string()
}

/// Compute the worktree path: `~/.yarr/worktrees/<repo_id>-oneshot-<short_id>`
///
/// Returns a Unix-style path. On all platforms the worktree lives on the
/// Unix filesystem (directly on Linux/macOS, inside WSL on Windows).
/// On Windows, queries WSL for `$HOME` since the Windows-side HOME env var
/// doesn't correspond to the WSL home directory.
pub fn worktree_path(repo_id: &str, short_id: &str) -> PathBuf {
    let home = resolve_unix_home();
    // Build path with forward slashes explicitly — PathBuf::join uses
    // backslashes on Windows which would break Unix/WSL paths.
    PathBuf::from(format!(
        "{home}/.yarr/worktrees/{}-oneshot-{short_id}",
        repo_id
    ))
}

/// Get the Unix home directory path.
/// On Windows, queries WSL for `$HOME`. On Unix, uses the `HOME` env var.
fn resolve_unix_home() -> String {
    if cfg!(windows) {
        // Query WSL for the home directory
        if let Ok(output) = std::process::Command::new("wsl")
            .args(["-e", "bash", "-lc", "echo $HOME"])
            .output()
        {
            let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !home.is_empty() && home.starts_with('/') {
                return home;
            }
        }
        "/tmp".to_string()
    } else {
        std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
    }
}

/// Truncate a string for logging, appending "..." if truncated.
fn truncate_for_log(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}

/// Compute the branch name: `oneshot/<slug>-<short_id>`
pub fn branch_name(slug: &str, short_id: &str) -> String {
    format!("oneshot/{}-{}", slug, short_id)
}

/// Result from a Claude phase invocation with diagnostic details.
struct ClaudePhaseResult {
    text: String,
    had_error: bool,
    exit_code: i32,
    stderr: String,
    /// File paths observed in Write/Edit tool_use inputs during this phase.
    tool_file_paths: Vec<String>,
}

impl ClaudePhaseResult {
    /// Build a human-readable error detail string for failed phases.
    fn error_detail(&self) -> String {
        let mut parts = Vec::new();
        if self.exit_code != 0 {
            parts.push(format!("exit code {}", self.exit_code));
        }
        let stderr_trimmed = self.stderr.trim();
        if !stderr_trimmed.is_empty() {
            // Truncate stderr to avoid huge messages
            let truncated = if stderr_trimmed.len() > 500 {
                format!("{}...", &stderr_trimmed[..500])
            } else {
                stderr_trimmed.to_string()
            };
            parts.push(truncated);
        }
        if parts.is_empty() {
            "unknown error".to_string()
        } else {
            parts.join(": ")
        }
    }
}

/// Orchestrates a 1-shot autonomous implementation session.
///
/// Lifecycle:
/// 1. Create git worktree
/// 2. Design phase (Claude generates a plan)
/// 3. Implementation phase (Claude implements the plan)
/// 4. Git finalize (merge to main or push branch)
pub struct OneShotRunner {
    config: OneShotConfig,
    collector: TraceCollector,
    cancel_token: CancellationToken,
    on_event: Option<OnSessionEvent>,
    abort_registry: Option<AbortRegistry>,
    accumulated_events: std::sync::Mutex<Vec<SessionEvent>>,
    session_id: std::sync::Mutex<Option<String>>,
}

impl OneShotRunner {
    pub fn new(
        config: OneShotConfig,
        collector: TraceCollector,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            config,
            collector,
            cancel_token,
            on_event: None,
            abort_registry: None,
            accumulated_events: std::sync::Mutex::new(Vec::new()),
            session_id: std::sync::Mutex::new(None),
        }
    }

    pub fn on_event(mut self, cb: OnSessionEvent) -> Self {
        self.on_event = Some(cb);
        self
    }

    pub fn abort_registry(mut self, registry: AbortRegistry) -> Self {
        self.abort_registry = Some(registry);
        self
    }

    pub fn with_session_id(self, id: String) -> Self {
        *self.session_id.lock().unwrap() = Some(id);
        self
    }

    fn emit(&self, event: SessionEvent) {
        self.accumulated_events.lock().unwrap().push(event.clone());
        if let Some(ref sid) = *self.session_id.lock().unwrap() {
            if let Err(e) = self.collector.append_event(sid, &event) {
                tracing::warn!("Failed to append event to disk: {e}");
            }
        }
        if let Some(ref cb) = self.on_event {
            cb(&event);
        }
    }

    fn strategy_string(&self) -> String {
        match self.config.merge_strategy {
            MergeStrategy::MergeToMain => "merge_to_main".to_string(),
            MergeStrategy::Branch => "branch".to_string(),
        }
    }

    /// Attempt best-effort cleanup of the worktree.
    async fn cleanup_worktree(&self, runtime: &dyn RuntimeProvider, wt_path: &PathBuf) {
        let _ = runtime
            .run_command(
                &format!("git worktree remove {}", wt_path.display()),
                &self.config.repo_path,
                Duration::from_secs(60),
            )
            .await;
    }

    /// Spawn claude and drain all events from the process, collecting text output.
    /// Returns the collected text, whether an error occurred, and diagnostic details.
    async fn run_claude_phase(
        &self,
        runtime: &dyn RuntimeProvider,
        invocation: &ClaudeInvocation,
        phase_name: &str,
    ) -> Result<ClaudePhaseResult> {
        let mut process = runtime.spawn_claude(invocation).await?;

        // Register abort handle so it can be called on app exit,
        // and keep a local Arc for cancellation during the event loop.
        let abort_arc: std::sync::Arc<dyn crate::runtime::AbortHandle> =
            std::sync::Arc::from(process.abort_handle);
        if let Some(ref registry) = self.abort_registry {
            registry.lock().unwrap().push(abort_arc.clone());
        }

        let mut collected_text = String::new();
        let mut had_error = false;
        let mut tool_file_paths: Vec<String> = Vec::new();

        // Drain events, but bail if cancellation is requested
        loop {
            let event = tokio::select! {
                event = process.events.recv() => {
                    let Some(event) = event else { break };
                    event
                }
                _ = self.cancel_token.cancelled() => {
                    tracing::info!("Phase cancelled, aborting Claude process");
                    abort_arc.abort();
                    anyhow::bail!("Cancelled");
                }
            };
            match &event {
                StreamEvent::Assistant(assistant) => {
                    for block in &assistant.message.content {
                        match block {
                            crate::output::ContentBlock::Text { text } => {
                                tracing::debug!("Claude text output: {}", truncate_for_log(text, 200));
                                collected_text.push_str(text);
                                self.emit(SessionEvent::PhaseOutput {
                                    phase: phase_name.to_string(),
                                    output_type: "text".to_string(),
                                    summary: truncate_for_log(text, 300),
                                });
                            }
                            crate::output::ContentBlock::ToolUse { name, input, .. } => {
                                tracing::debug!("Claude tool_use: {} input={}", name, truncate_for_log(&input.to_string(), 200));
                                // Extract file paths from Write/Edit tool inputs
                                if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
                                    tool_file_paths.push(file_path.to_string());
                                }
                                {
                                    let tool_summary = match name.as_str() {
                                        "Write" | "Edit" | "Read" => {
                                            let fp = input.get("file_path").and_then(|v| v.as_str()).unwrap_or("?");
                                            format!("{}: {}", name, fp)
                                        }
                                        "Bash" => {
                                            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("?");
                                            format!("{}: {}", name, truncate_for_log(cmd, 100))
                                        }
                                        "Glob" | "Grep" => {
                                            let pat = input.get("pattern").and_then(|v| v.as_str()).unwrap_or("?");
                                            format!("{}: {}", name, pat)
                                        }
                                        _ => name.to_string(),
                                    };
                                    self.emit(SessionEvent::PhaseOutput {
                                        phase: phase_name.to_string(),
                                        output_type: "tool_use".to_string(),
                                        summary: tool_summary,
                                    });
                                }
                            }
                            _ => {}
                        }
                    }
                }
                StreamEvent::Result(result) => {
                    tracing::debug!("Claude result: is_error={}, result_text_len={}", result.is_error, result.result.as_ref().map(|t| t.len()).unwrap_or(0));
                    if result.is_error {
                        had_error = true;
                    }
                    if let Some(ref text) = result.result {
                        if collected_text.is_empty() {
                            collected_text = text.clone();
                        }
                    }
                }
                _ => {}
            }
        }

        // Wait for process completion
        let exit = process.completion.await??;
        tracing::debug!("Claude process exited: code={}, stderr_len={}", exit.exit_code, exit.stderr.len());
        if exit.exit_code != 0 {
            had_error = true;
        }

        Ok(ClaudePhaseResult {
            text: collected_text,
            had_error,
            exit_code: exit.exit_code,
            stderr: exit.stderr,
            tool_file_paths,
        })
    }

    /// Extract a plan file path from the design phase output text.
    /// Looks for references to `docs/plans/*.md` in the text.
    fn extract_plan_file_from_output(&self, text: &str) -> Option<String> {
        // Look for a path like docs/plans/something.md
        for word in text.split_whitespace() {
            let cleaned = word.trim_matches(|c: char| !c.is_alphanumeric() && c != '/' && c != '-' && c != '_' && c != '.');
            if cleaned.contains("docs/plans/") && cleaned.ends_with(".md") {
                return Some(cleaned.to_string());
            }
        }
        // Also try to find it with backtick-wrapped paths
        for segment in text.split('`') {
            let trimmed = segment.trim();
            if trimmed.contains("docs/plans/") && trimmed.ends_with(".md") {
                return Some(trimmed.to_string());
            }
        }
        None
    }

    /// Run the full 1-shot lifecycle.
    pub async fn run(&self, runtime: &dyn RuntimeProvider) -> Result<SessionTrace> {
        let repo_str = self.config.repo_path.to_string_lossy().to_string();
        let mut trace = match self.session_id.lock().unwrap().as_ref() {
            Some(sid) => self.collector.start_session_with_id(sid, &repo_str, &self.config.prompt, None),
            None => self.collector.start_session(&repo_str, &self.config.prompt, None),
        };
        trace.session_type = "one_shot".to_string();
        *self.session_id.lock().unwrap() = Some(trace.session_id.clone());

        let slug = slugify(&self.config.title);
        let short_id = generate_short_id();
        let wt_path = worktree_path(&self.config.repo_id, &short_id);
        let branch = branch_name(&slug, &short_id);

        // Emit OneShotStarted
        self.emit(SessionEvent::OneShotStarted {
            title: self.config.title.clone(),
            merge_strategy: self.strategy_string(),
        });

        // Check cancellation before worktree creation
        if self.cancel_token.is_cancelled() {
            self.emit(SessionEvent::OneShotFailed {
                reason: "Cancelled".to_string(),
            });
            trace.outcome = SessionOutcome::Cancelled;
            trace.end_time = Some(Utc::now());
            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
            let _ = self.collector.finalize(&mut trace, &events).await;
            return Err(anyhow::anyhow!("Cancelled"));
        }

        // 1. Create worktree (ensure parent directory exists first)
        if let Some(parent) = wt_path.parent() {
            let _ = runtime
                .run_command(
                    &format!("mkdir -p {}", parent.display()),
                    &self.config.repo_path,
                    Duration::from_secs(30),
                )
                .await;
        }

        let output = runtime
            .run_command(
                &format!("git worktree add {} -b {}", wt_path.display(), branch),
                &self.config.repo_path,
                Duration::from_secs(60),
            )
            .await?;

        if output.exit_code != 0 {
            let reason = format!(
                "Failed to create worktree: {}",
                if output.stderr.is_empty() {
                    &output.stdout
                } else {
                    &output.stderr
                }
            );
            self.emit(SessionEvent::OneShotFailed { reason });
            trace.outcome = SessionOutcome::Failed;
            trace.end_time = Some(Utc::now());
            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
            let _ = self.collector.finalize(&mut trace, &events).await;
            return Err(anyhow::anyhow!("Worktree creation failed"));
        }

        // Check cancellation after worktree creation
        if self.cancel_token.is_cancelled() {
            self.cleanup_worktree(runtime, &wt_path).await;
            self.emit(SessionEvent::OneShotFailed {
                reason: "Cancelled".to_string(),
            });
            trace.outcome = SessionOutcome::Cancelled;
            trace.end_time = Some(Utc::now());
            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
            let _ = self.collector.finalize(&mut trace, &events).await;
            return Err(anyhow::anyhow!("Cancelled"));
        }

        // 2. Design phase
        self.emit(SessionEvent::DesignPhaseStarted);

        let design_prompt = prompt::build_design_prompt(&self.config.prompt, &self.config.title);
        let design_invocation = ClaudeInvocation {
            prompt: design_prompt,
            working_dir: wt_path.clone(),
            model: Some(self.config.model.clone()),
            extra_args: vec!["--dangerously-skip-permissions".to_string()],
            env_vars: self.config.env_vars.clone(),
        };

        tracing::info!("Starting design phase for '{}'", self.config.title);
        let design_result = self.run_claude_phase(runtime, &design_invocation, "design").await;

        match design_result {
            Ok(design) => {
                tracing::info!(
                    "Design phase finished: exit_code={}, had_error={}, text_len={}, tool_file_paths={:?}",
                    design.exit_code, design.had_error, design.text.len(), design.tool_file_paths
                );

                if design.had_error {
                    let detail = design.error_detail();
                    tracing::warn!("Design phase had error: {}", detail);
                    self.cleanup_worktree(runtime, &wt_path).await;
                    self.emit(SessionEvent::OneShotFailed {
                        reason: format!("Design phase Claude invocation failed: {}", detail),
                    });
                    trace.outcome = SessionOutcome::Failed;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Design phase failed"));
                }

                // Try to extract plan file path from output text
                let plan_file = self.extract_plan_file_from_output(&design.text);
                tracing::debug!("Plan file from text extraction: {:?}", plan_file);

                // Also try to find plan file from tool_use file paths
                let plan_file_from_tools = design.tool_file_paths.iter()
                    .find(|p| p.contains("docs/plans/") && p.ends_with(".md"))
                    .or_else(|| design.tool_file_paths.iter().find(|p| p.ends_with("-design.md")))
                    .cloned();
                tracing::debug!("Plan file from tool_use paths: {:?}", plan_file_from_tools);

                // Determine the plan file path
                let plan_file_path = if let Some(p) = plan_file {
                    // Found a plan file reference in the text output
                    tracing::info!("Using plan file from text: {}", p);
                    p
                } else if let Some(p) = plan_file_from_tools {
                    // Found a plan file from tool_use inputs (Write/Edit)
                    tracing::info!("Using plan file from tool_use: {}", p);
                    // Make path relative if it's absolute and within the worktree
                    let wt_prefix = format!("{}/", wt_path.display());
                    if p.starts_with(&wt_prefix) {
                        p[wt_prefix.len()..].to_string()
                    } else {
                        p
                    }
                } else if design.text.contains("<promise>COMPLETE</promise>") {
                    // Claude claimed completion but didn't reference a plan file
                    // in text or tools. Log what we have for debugging.
                    tracing::warn!(
                        "Design phase claimed COMPLETE but no plan file found. \
                         text_len={}, tool_file_paths={:?}, text_preview={}",
                        design.text.len(),
                        design.tool_file_paths,
                        truncate_for_log(&design.text, 500)
                    );
                    self.cleanup_worktree(runtime, &wt_path).await;
                    self.emit(SessionEvent::OneShotFailed {
                        reason: format!(
                            "Design phase did not produce a plan file. \
                             Claude output {} chars of text and used {} tool calls with file paths: {:?}",
                            design.text.len(),
                            design.tool_file_paths.len(),
                            design.tool_file_paths
                        ),
                    });
                    trace.outcome = SessionOutcome::Failed;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Design phase did not produce a plan file"));
                } else {
                    // Claude didn't signal completion and didn't reference a plan file.
                    // Generate a default plan file path (Claude likely wrote it but
                    // didn't explicitly reference the path in its text output).
                    let date = Utc::now().format("%Y-%m-%d").to_string();
                    let default_path = format!("docs/plans/{}-{}-design.md", date, slug);
                    tracing::info!("No plan file found in output, using default: {}", default_path);
                    default_path
                };

                self.emit(SessionEvent::DesignPhaseComplete {
                    plan_file: plan_file_path.clone(),
                });

                // Check cancellation
                if self.cancel_token.is_cancelled() {
                    self.cleanup_worktree(runtime, &wt_path).await;
                    self.emit(SessionEvent::OneShotFailed {
                        reason: "Cancelled".to_string(),
                    });
                    trace.outcome = SessionOutcome::Cancelled;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Cancelled"));
                }

                // 3. Implementation phase
                self.emit(SessionEvent::ImplementationPhaseStarted);

                let plan_file_abs = format!("{}/{}", wt_path.display(), plan_file_path);
                let impl_prompt = prompt::build_prompt(&plan_file_abs);
                let impl_invocation = ClaudeInvocation {
                    prompt: impl_prompt,
                    working_dir: wt_path.clone(),
                    model: Some(self.config.model.clone()),
                    extra_args: vec!["--dangerously-skip-permissions".to_string()],
                    env_vars: self.config.env_vars.clone(),
                };

                tracing::info!("Starting implementation phase");
                let impl_result = self.run_claude_phase(runtime, &impl_invocation, "implementation").await;

                match impl_result {
                    Ok(impl_phase) => {
                        if impl_phase.had_error {
                            let detail = impl_phase.error_detail();
                            self.cleanup_worktree(runtime, &wt_path).await;
                            self.emit(SessionEvent::OneShotFailed {
                                reason: format!("Implementation phase Claude invocation failed: {}", detail),
                            });
                            trace.outcome = SessionOutcome::Failed;
                            trace.end_time = Some(Utc::now());
                            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                            let _ = self.collector.finalize(&mut trace, &events).await;
                            return Err(anyhow::anyhow!("Implementation phase failed"));
                        }

                        self.emit(SessionEvent::ImplementationPhaseComplete);
                    }
                    Err(e) => {
                        self.cleanup_worktree(runtime, &wt_path).await;
                        self.emit(SessionEvent::OneShotFailed {
                            reason: format!("Implementation phase error: {}", e),
                        });
                        trace.outcome = SessionOutcome::Failed;
                        trace.end_time = Some(Utc::now());
                        let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                        let _ = self.collector.finalize(&mut trace, &events).await;
                        return Err(e);
                    }
                }

                // Check cancellation
                if self.cancel_token.is_cancelled() {
                    self.cleanup_worktree(runtime, &wt_path).await;
                    self.emit(SessionEvent::OneShotFailed {
                        reason: "Cancelled".to_string(),
                    });
                    trace.outcome = SessionOutcome::Cancelled;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Cancelled"));
                }

                // 4. Git finalize
                let strategy_str = self.strategy_string();
                self.emit(SessionEvent::GitFinalizeStarted {
                    strategy: strategy_str.clone(),
                });

                match self.config.merge_strategy {
                    MergeStrategy::MergeToMain => {
                        // All git operations happen inside the worktree to avoid
                        // touching the user's main repo checkout.

                        // 1. Fetch latest origin/main
                        let fetch = runtime
                            .run_command(
                                "git fetch origin main",
                                &wt_path,
                                Duration::from_secs(120),
                            )
                            .await?;

                        if fetch.exit_code != 0 {
                            let fetch_err = if fetch.stderr.is_empty() { &fetch.stdout } else { &fetch.stderr };
                            self.emit(SessionEvent::OneShotFailed {
                                reason: format!(
                                    "Failed to fetch origin/main: {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree and push manually. Once done, remove the worktree with:\ngit worktree remove {}",
                                    fetch_err, branch, wt_path.display(), wt_path.display()
                                ),
                            });
                            trace.outcome = SessionOutcome::Failed;
                            trace.end_time = Some(Utc::now());
                            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                            let _ = self.collector.finalize(&mut trace, &events).await;
                            return Err(anyhow::anyhow!("Fetch failed"));
                        }

                        // 2. Rebase our branch onto origin/main
                        let rebase = runtime
                            .run_command(
                                "git rebase origin/main",
                                &wt_path,
                                Duration::from_secs(120),
                            )
                            .await?;

                        if rebase.exit_code != 0 {
                            // Abort rebase to leave worktree in a clean state
                            let _ = runtime.run_command("git rebase --abort", &wt_path, Duration::from_secs(30)).await;
                            let rebase_err = if rebase.stderr.is_empty() { &rebase.stdout } else { &rebase.stderr };
                            self.emit(SessionEvent::OneShotFailed {
                                reason: format!(
                                    "Rebase onto origin/main failed (conflicts): {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree, rebase manually, then push. Once done, remove the worktree with:\ngit worktree remove {}",
                                    rebase_err, branch, wt_path.display(), wt_path.display()
                                ),
                            });
                            trace.outcome = SessionOutcome::Failed;
                            trace.end_time = Some(Utc::now());
                            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                            let _ = self.collector.finalize(&mut trace, &events).await;
                            return Err(anyhow::anyhow!("Rebase failed"));
                        }

                        // 3. Push rebased branch directly to origin/main
                        // We skip checkout + ff-merge because `main` may already be
                        // checked out in the primary worktree, which git forbids.
                        let push = runtime
                            .run_command(
                                &format!("git push origin {}:main", branch),
                                &wt_path,
                                Duration::from_secs(120),
                            )
                            .await?;

                        if push.exit_code != 0 {
                            let push_err = if push.stderr.is_empty() { &push.stdout } else { &push.stderr };
                            self.emit(SessionEvent::OneShotFailed {
                                reason: format!(
                                    "Push failed: {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree, pull/rebase, then push manually. Once done, remove the worktree with:\ngit worktree remove {}",
                                    push_err, branch, wt_path.display(), wt_path.display()
                                ),
                            });
                            trace.outcome = SessionOutcome::Failed;
                            trace.end_time = Some(Utc::now());
                            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                            let _ = self.collector.finalize(&mut trace, &events).await;
                            return Err(anyhow::anyhow!("Push failed"));
                        }

                        // 6. Clean up: delete branch and remove worktree
                        let _ = runtime
                            .run_command(
                                &format!("git branch -d {}", branch),
                                &wt_path,
                                Duration::from_secs(60),
                            )
                            .await;

                        let _ = runtime
                            .run_command(
                                &format!("git worktree remove {}", wt_path.display()),
                                &self.config.repo_path,
                                Duration::from_secs(60),
                            )
                            .await;
                    }
                    MergeStrategy::Branch => {
                        // push branch
                        let push = runtime
                            .run_command(
                                &format!("git push -u origin {}", branch),
                                &wt_path,
                                Duration::from_secs(60),
                            )
                            .await?;
                        if push.exit_code != 0 {
                            // Don't cleanup worktree on push failure
                            let push_err = if push.stderr.is_empty() { &push.stdout } else { &push.stderr };
                            self.emit(SessionEvent::OneShotFailed {
                                reason: format!(
                                    "Push failed: {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree, pull/rebase, then push manually. Once done, remove the worktree with:\ngit worktree remove {}",
                                    push_err, branch, wt_path.display(), wt_path.display()
                                ),
                            });
                            trace.outcome = SessionOutcome::Failed;
                            trace.end_time = Some(Utc::now());
                            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                            let _ = self.collector.finalize(&mut trace, &events).await;
                            return Err(anyhow::anyhow!("Push failed"));
                        }

                        // remove worktree
                        let _ = runtime
                            .run_command(
                                &format!("git worktree remove {}", wt_path.display()),
                                &self.config.repo_path,
                                Duration::from_secs(60),
                            )
                            .await;
                    }
                }

                self.emit(SessionEvent::GitFinalizeComplete);

                // 5. Complete
                self.emit(SessionEvent::OneShotComplete);
                trace.outcome = SessionOutcome::Completed;
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                self.collector.finalize(&mut trace, &events).await?;
                Ok(trace)
            }
            Err(e) => {
                self.cleanup_worktree(runtime, &wt_path).await;
                self.emit(SessionEvent::OneShotFailed {
                    reason: format!("Design phase error: {}", e),
                });
                trace.outcome = SessionOutcome::Failed;
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                let _ = self.collector.finalize(&mut trace, &events).await;
                Err(e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{CommandOutput, MockRuntime};
    use crate::session::SessionEvent;
    use crate::trace::TraceCollector;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    // =========================================================================
    // Helper: create a default OneShotConfig for testing
    // =========================================================================

    fn make_config(tmp: &TempDir, merge_strategy: MergeStrategy) -> OneShotConfig {
        OneShotConfig {
            repo_id: "test-repo".to_string(),
            repo_path: tmp.path().to_path_buf(),
            title: "Add login feature".to_string(),
            prompt: "Implement user login with email and password".to_string(),
            model: "claude-sonnet".to_string(),
            merge_strategy,
            env_vars: HashMap::new(),
        }
    }

    // =========================================================================
    // slugify tests
    // =========================================================================

    #[test]
    fn test_slugify_basic() {
        assert_eq!(slugify("Hello World"), "hello-world");
    }

    #[test]
    fn test_slugify_special_chars() {
        assert_eq!(slugify("My Feature (v2.0)!"), "my-feature-v2-0");
    }

    #[test]
    fn test_slugify_multiple_hyphens() {
        assert_eq!(slugify("a---b"), "a-b");
    }

    #[test]
    fn test_slugify_leading_trailing() {
        assert_eq!(slugify("--hello--"), "hello");
    }

    #[test]
    fn test_slugify_truncation() {
        let long_title = "a".repeat(100);
        let slug = slugify(&long_title);
        assert!(
            slug.len() <= 50,
            "slug should be at most 50 chars, got {} chars: '{}'",
            slug.len(),
            slug
        );
        // Should be 50 'a's (no hyphens to trim)
        assert_eq!(slug.len(), 50);
    }

    #[test]
    fn test_slugify_empty() {
        let slug = slugify("");
        assert_eq!(slug, "");
    }

    #[test]
    fn test_slugify_unicode() {
        // Unicode should be replaced with hyphens, then collapsed/trimmed
        let slug = slugify("café résumé");
        // Non-ASCII chars become hyphens, spaces become hyphens, then collapse
        assert!(!slug.is_empty(), "unicode input should produce a non-empty slug");
        assert!(
            slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
            "slug should only contain ascii alphanumerics and hyphens, got: '{}'",
            slug
        );
    }

    #[test]
    fn test_slugify_only_special_chars() {
        let slug = slugify("!!!@@@###");
        // All chars replaced by hyphens, then trimmed
        assert_eq!(slug, "");
    }

    #[test]
    fn test_slugify_preserves_numbers() {
        assert_eq!(slugify("version 42 release"), "version-42-release");
    }

    #[test]
    fn test_slugify_truncation_does_not_end_with_hyphen() {
        // If truncation would leave a trailing hyphen, it should be trimmed
        // "a-" repeated 30 times = 60 chars, truncated to 50 = "a-a-a-...-a-" which should trim trailing hyphen
        let title = "a ".repeat(30); // "a a a a ..." -> "a-a-a-a-..." slug
        let slug = slugify(&title);
        assert!(slug.len() <= 50);
        assert!(
            !slug.ends_with('-'),
            "slug should not end with a hyphen after truncation, got: '{}'",
            slug
        );
    }

    // =========================================================================
    // generate_short_id tests
    // =========================================================================

    #[test]
    fn test_generate_short_id_length() {
        let id = generate_short_id();
        assert_eq!(
            id.len(),
            6,
            "short id should be 6 chars, got {} chars: '{}'",
            id.len(),
            id
        );
    }

    #[test]
    fn test_generate_short_id_is_hex() {
        let id = generate_short_id();
        assert!(
            id.chars().all(|c| c.is_ascii_hexdigit()),
            "short id should be hex chars, got: '{}'",
            id
        );
    }

    #[test]
    fn test_generate_short_id_uniqueness() {
        let id1 = generate_short_id();
        let id2 = generate_short_id();
        assert_ne!(
            id1, id2,
            "two calls to generate_short_id should produce different values"
        );
    }

    // =========================================================================
    // worktree_path tests
    // =========================================================================

    #[test]
    fn test_worktree_path() {
        let path = worktree_path("my-repo", "abc123");
        let expected_suffix = std::path::Path::new(".yarr")
            .join("worktrees")
            .join("my-repo-oneshot-abc123");
        // The path should end with the expected components
        assert!(
            path.ends_with(&expected_suffix),
            "worktree_path should end with '.yarr/worktrees/my-repo-oneshot-abc123', got: '{}'",
            path.display()
        );
    }

    #[test]
    fn test_worktree_path_starts_with_home() {
        let path = worktree_path("repo", "id1234");
        // Should be an absolute Unix path (starts with /)
        let path_str = path.to_string_lossy();
        assert!(
            path_str.starts_with('/'),
            "worktree_path should start with '/', got: '{}'",
            path_str
        );
    }

    #[test]
    fn test_worktree_path_different_inputs() {
        let path1 = worktree_path("repo-a", "aaa111");
        let path2 = worktree_path("repo-b", "bbb222");
        assert_ne!(
            path1, path2,
            "different inputs should produce different paths"
        );
    }

    // =========================================================================
    // branch_name tests
    // =========================================================================

    #[test]
    fn test_branch_name() {
        let name = branch_name("add-login-feature", "abc123");
        assert_eq!(name, "oneshot/add-login-feature-abc123");
    }

    #[test]
    fn test_branch_name_format() {
        let name = branch_name("my-slug", "def456");
        assert!(
            name.starts_with("oneshot/"),
            "branch name should start with 'oneshot/', got: '{}'",
            name
        );
        assert!(
            name.ends_with("def456"),
            "branch name should end with the short_id, got: '{}'",
            name
        );
        assert!(
            name.contains("my-slug"),
            "branch name should contain the slug, got: '{}'",
            name
        );
    }

    // =========================================================================
    // OneShotConfig construction test
    // =========================================================================

    #[test]
    fn test_oneshot_config_fields() {
        let config = OneShotConfig {
            repo_id: "repo-123".to_string(),
            repo_path: PathBuf::from("/home/user/project"),
            title: "Implement OAuth".to_string(),
            prompt: "Add OAuth2 support with Google provider".to_string(),
            model: "claude-opus".to_string(),
            merge_strategy: MergeStrategy::MergeToMain,
            env_vars: HashMap::from([("API_KEY".to_string(), "test-key".to_string())]),
        };

        assert_eq!(config.repo_id, "repo-123");
        assert_eq!(config.repo_path, PathBuf::from("/home/user/project"));
        assert_eq!(config.title, "Implement OAuth");
        assert_eq!(config.prompt, "Add OAuth2 support with Google provider");
        assert_eq!(config.model, "claude-opus");
        assert_eq!(config.merge_strategy, MergeStrategy::MergeToMain);
        assert_eq!(config.env_vars.get("API_KEY"), Some(&"test-key".to_string()));
    }

    #[test]
    fn test_oneshot_config_with_branch_strategy() {
        let config = OneShotConfig {
            repo_id: "repo-456".to_string(),
            repo_path: PathBuf::from("/tmp/project"),
            title: "Fix bug #42".to_string(),
            prompt: "Fix the null pointer in auth handler".to_string(),
            model: "claude-sonnet".to_string(),
            merge_strategy: MergeStrategy::Branch,
            env_vars: HashMap::new(),
        };

        assert_eq!(config.merge_strategy, MergeStrategy::Branch);
        assert!(config.env_vars.is_empty());
    }

    // =========================================================================
    // MergeStrategy serde tests
    // =========================================================================

    #[test]
    fn test_merge_strategy_serde_merge_to_main() {
        let strategy = MergeStrategy::MergeToMain;
        let json = serde_json::to_value(&strategy).expect("serialize MergeToMain");
        assert_eq!(json, serde_json::json!("merge_to_main"));

        let deserialized: MergeStrategy =
            serde_json::from_value(json).expect("deserialize MergeToMain");
        assert_eq!(deserialized, MergeStrategy::MergeToMain);
    }

    #[test]
    fn test_merge_strategy_serde_branch() {
        let strategy = MergeStrategy::Branch;
        let json = serde_json::to_value(&strategy).expect("serialize Branch");
        assert_eq!(json, serde_json::json!("branch"));

        let deserialized: MergeStrategy =
            serde_json::from_value(json).expect("deserialize Branch");
        assert_eq!(deserialized, MergeStrategy::Branch);
    }

    #[test]
    fn test_merge_strategy_roundtrip() {
        for strategy in [MergeStrategy::MergeToMain, MergeStrategy::Branch] {
            let json_str = serde_json::to_string(&strategy).expect("serialize");
            let deserialized: MergeStrategy =
                serde_json::from_str(&json_str).expect("deserialize");
            assert_eq!(deserialized, strategy);
        }
    }

    #[test]
    fn test_merge_strategy_invalid_value_fails() {
        let result = serde_json::from_str::<MergeStrategy>(r#""invalid_strategy""#);
        assert!(
            result.is_err(),
            "deserializing an invalid strategy should fail"
        );
    }

    // =========================================================================
    // OneShotRunner constructor & builder tests
    // =========================================================================

    #[test]
    fn test_oneshot_runner_new() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::Branch);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();

        // Should construct without panicking
        let _runner = OneShotRunner::new(config, collector, cancel_token);
    }

    #[test]
    fn test_oneshot_runner_on_event_builder() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::Branch);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();

        let _runner = OneShotRunner::new(config, collector, cancel_token)
            .on_event(Box::new(|_event| {}));
    }

    #[test]
    fn test_oneshot_runner_abort_registry_builder() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::Branch);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();
        let registry: AbortRegistry = Arc::new(std::sync::Mutex::new(Vec::new()));

        let _runner = OneShotRunner::new(config, collector, cancel_token)
            .abort_registry(registry);
    }

    #[test]
    fn test_oneshot_runner_full_builder_chain() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::MergeToMain);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();
        let registry: AbortRegistry = Arc::new(std::sync::Mutex::new(Vec::new()));

        let _runner = OneShotRunner::new(config, collector, cancel_token)
            .on_event(Box::new(|_event| {}))
            .abort_registry(registry);
    }

    // =========================================================================
    // Integration tests with MockRuntime
    // =========================================================================

    /// Helper: set up a runner with event capture and return (runner, events_handle).
    fn setup_runner_with_events(
        tmp: &TempDir,
        merge_strategy: MergeStrategy,
    ) -> (OneShotRunner, Arc<Mutex<Vec<SessionEvent>>>) {
        let config = make_config(tmp, merge_strategy);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();
        let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();

        let runner = OneShotRunner::new(config, collector, cancel_token).on_event(Box::new(
            move |event| {
                events_clone.lock().unwrap().push(event.clone());
            },
        ));

        (runner, events)
    }

    #[tokio::test]
    async fn test_oneshot_merge_to_main_flow() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::MergeToMain);

        // MockRuntime with 2 Claude spawns (design + implementation) completing
        let mut runtime = MockRuntime::completing_after(1);
        // Add a second scenario for the implementation phase
        // completing_after(1) gives: 1 working iteration + 1 completion = 2 scenarios
        // We need the design phase to complete (1 spawn) and implementation to complete (1 spawn)
        // So completing_after(1) provides enough scenarios for 2 spawn_claude calls

        // Command results in order:
        // 1. mkdir -p (success, ignored)
        // 2. git worktree add (success)
        // 3. git fetch origin main (success)
        // 4. git rebase origin/main (success)
        // 5. git push origin <branch>:main (success)
        // 6. git branch -d <branch> (success)
        // 7. git worktree remove <path> (success)
        // MockRuntime returns success by default when command_results is
        // exhausted, so we only need to provide the first few explicitly.
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Deleted branch".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;
        assert!(result.is_ok(), "run should succeed, got: {:?}", result.err());

        let trace = result.unwrap();
        assert_eq!(trace.session_type, "one_shot");

        let captured = events.lock().unwrap();

        // Verify the expected event sequence
        let event_kinds: Vec<&str> = captured
            .iter()
            .map(|e| match e {
                SessionEvent::OneShotStarted { .. } => "one_shot_started",
                SessionEvent::DesignPhaseStarted => "design_phase_started",
                SessionEvent::DesignPhaseComplete { .. } => "design_phase_complete",
                SessionEvent::ImplementationPhaseStarted => "implementation_phase_started",
                SessionEvent::ImplementationPhaseComplete => "implementation_phase_complete",
                SessionEvent::GitFinalizeStarted { .. } => "git_finalize_started",
                SessionEvent::GitFinalizeComplete => "git_finalize_complete",
                SessionEvent::OneShotComplete => "one_shot_complete",
                _ => "other",
            })
            .collect();

        // Check that all key lifecycle events are present
        assert!(
            event_kinds.contains(&"one_shot_started"),
            "should emit OneShotStarted, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"design_phase_started"),
            "should emit DesignPhaseStarted, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"design_phase_complete"),
            "should emit DesignPhaseComplete, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"implementation_phase_started"),
            "should emit ImplementationPhaseStarted, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"implementation_phase_complete"),
            "should emit ImplementationPhaseComplete, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"git_finalize_started"),
            "should emit GitFinalizeStarted, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"git_finalize_complete"),
            "should emit GitFinalizeComplete, got: {:?}",
            event_kinds
        );
        assert!(
            event_kinds.contains(&"one_shot_complete"),
            "should emit OneShotComplete, got: {:?}",
            event_kinds
        );

        // Verify ordering: started -> design -> implementation -> finalize -> complete
        let started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::OneShotStarted { .. }))
            .expect("should have OneShotStarted");
        let design_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::DesignPhaseStarted))
            .expect("should have DesignPhaseStarted");
        let design_complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::DesignPhaseComplete { .. }))
            .expect("should have DesignPhaseComplete");
        let impl_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::ImplementationPhaseStarted))
            .expect("should have ImplementationPhaseStarted");
        let impl_complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::ImplementationPhaseComplete))
            .expect("should have ImplementationPhaseComplete");
        let finalize_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. }))
            .expect("should have GitFinalizeStarted");
        let finalize_complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::GitFinalizeComplete))
            .expect("should have GitFinalizeComplete");
        let complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::OneShotComplete))
            .expect("should have OneShotComplete");

        assert!(started_idx < design_started_idx);
        assert!(design_started_idx < design_complete_idx);
        assert!(design_complete_idx < impl_started_idx);
        assert!(impl_started_idx < impl_complete_idx);
        assert!(impl_complete_idx < finalize_started_idx);
        assert!(finalize_started_idx < finalize_complete_idx);
        assert!(finalize_complete_idx < complete_idx);

        // Verify OneShotStarted contains the title and strategy
        match &captured[started_idx] {
            SessionEvent::OneShotStarted {
                title,
                merge_strategy,
            } => {
                assert_eq!(title, "Add login feature");
                assert_eq!(merge_strategy, "merge_to_main");
            }
            _ => panic!("expected OneShotStarted"),
        }

        // Verify GitFinalizeStarted uses merge_to_main strategy
        match &captured[finalize_started_idx] {
            SessionEvent::GitFinalizeStarted { strategy } => {
                assert_eq!(strategy, "merge_to_main");
            }
            _ => panic!("expected GitFinalizeStarted"),
        }

        // Should NOT have any failure events
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotFailed { .. })),
            "should not emit OneShotFailed on success"
        );
    }

    #[tokio::test]
    async fn test_oneshot_branch_flow() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        let mut runtime = MockRuntime::completing_after(1);

        // Command results in order for Branch strategy:
        // 1. git worktree add (success)
        // 2. git push -u origin <branch> (success)
        // 3. git worktree remove <path> (success)
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Branch pushed".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;
        assert!(result.is_ok(), "run should succeed, got: {:?}", result.err());

        let captured = events.lock().unwrap();

        // Verify GitFinalizeStarted uses "branch" strategy
        let finalize_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. }));
        assert!(
            finalize_event.is_some(),
            "should have GitFinalizeStarted event"
        );
        match finalize_event.unwrap() {
            SessionEvent::GitFinalizeStarted { strategy } => {
                assert_eq!(strategy, "branch");
            }
            _ => unreachable!(),
        }

        // Verify OneShotStarted shows "branch" strategy
        let started_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotStarted { .. }));
        assert!(
            started_event.is_some(),
            "should have OneShotStarted event"
        );
        match started_event.unwrap() {
            SessionEvent::OneShotStarted {
                merge_strategy, ..
            } => {
                assert_eq!(merge_strategy, "branch");
            }
            _ => unreachable!(),
        }

        // Verify complete lifecycle
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should emit OneShotComplete"
        );
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotFailed { .. })),
            "should not emit OneShotFailed on success"
        );
    }

    #[tokio::test]
    async fn test_oneshot_cancellation() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::Branch);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();
        let events: Arc<Mutex<Vec<SessionEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();

        let runner = OneShotRunner::new(config, collector, cancel_token.clone()).on_event(
            Box::new(move |event| {
                events_clone.lock().unwrap().push(event.clone());
            }),
        );

        // Cancel immediately
        cancel_token.cancel();

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "Preparing worktree".to_string(),
            stderr: String::new(),
        }];

        let _result = runner.run(&runtime).await;

        // The run should either error or complete with a failure trace
        let captured = events.lock().unwrap();

        // Should have OneShotFailed event
        let failed_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed_event.is_some(),
            "should emit OneShotFailed on cancellation, events: {:?}",
            *captured
        );

        // Should NOT have OneShotComplete
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should not emit OneShotComplete when cancelled"
        );
    }

    #[tokio::test]
    async fn test_oneshot_design_phase_failure() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        // Create a MockRuntime where spawn_claude will produce an error scenario
        let mut runtime = MockRuntime::completing_after(0);
        // Worktree add succeeds, but then design phase Claude call fails
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // Worktree remove for cleanup
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        // The MockRuntime::completing_after(0) produces a single scenario that completes
        // immediately. In a real failure scenario, the design phase would fail to
        // produce a plan file. The implementation should detect this and emit OneShotFailed.
        let _result = runner.run(&runtime).await;

        let captured = events.lock().unwrap();

        // If the design phase fails, we expect:
        // 1. OneShotStarted
        // 2. DesignPhaseStarted
        // 3. OneShotFailed (with reason)
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotStarted { .. })),
            "should emit OneShotStarted even on failure, events: {:?}",
            *captured
        );

        // Design phase should have started
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::DesignPhaseStarted)),
            "should emit DesignPhaseStarted, events: {:?}",
            *captured
        );

        // If design phase fails to produce a plan file, should emit OneShotFailed
        let failed = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed.is_some(),
            "should emit OneShotFailed when design phase fails, events: {:?}",
            *captured
        );

        // Should NOT have implementation phase events
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::ImplementationPhaseStarted)),
            "should not start implementation phase after design failure"
        );

        // Should NOT have OneShotComplete
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should not emit OneShotComplete when design phase fails"
        );
    }

    #[tokio::test]
    async fn test_oneshot_worktree_creation_failure() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        let mut runtime = MockRuntime::completing_after(1);
        // Worktree add fails
        runtime.command_results = vec![CommandOutput {
            exit_code: 128,
            stdout: String::new(),
            stderr: "fatal: 'some-path' already exists".to_string(),
        }];

        let _result = runner.run(&runtime).await;

        let captured = events.lock().unwrap();

        // Should emit OneShotFailed with a reason about worktree creation
        let failed = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed.is_some(),
            "should emit OneShotFailed when worktree creation fails, events: {:?}",
            *captured
        );

        // Should NOT proceed to design phase
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::DesignPhaseStarted)),
            "should not start design phase after worktree creation failure"
        );
    }

    #[tokio::test]
    async fn test_oneshot_git_finalize_failure_rebase_conflict() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::MergeToMain);

        let mut runtime = MockRuntime::completing_after(1);

        // Command results:
        // 1. mkdir -p (success)
        // 2. git worktree add (success)
        // 3. git fetch origin main (success)
        // 4. git rebase origin/main (FAIL — conflict)
        // 5. git rebase --abort (cleanup)
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "CONFLICT (content): Merge conflict in src/main.rs".to_string(),
            },
            // rebase --abort cleanup
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let _result = runner.run(&runtime).await;

        let captured = events.lock().unwrap();

        // Should have started finalize
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. })),
            "should emit GitFinalizeStarted, events: {:?}",
            *captured
        );

        // Should have OneShotFailed (due to rebase conflict)
        let failed_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed_event.is_some(),
            "should emit OneShotFailed when rebase fails, events: {:?}",
            *captured
        );

        // Verify the failure reason mentions rebase and worktree path
        if let Some(SessionEvent::OneShotFailed { reason }) = failed_event {
            assert!(
                reason.contains("Rebase"),
                "failure reason should mention rebase, got: {}",
                reason
            );
            assert!(
                reason.contains("worktree"),
                "failure reason should mention worktree path, got: {}",
                reason
            );
        }

        // Should NOT have OneShotComplete
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should not emit OneShotComplete when rebase fails"
        );
    }

    #[tokio::test]
    async fn test_oneshot_design_phase_emits_plan_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Branch pushed".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;

        // If the run succeeds, the DesignPhaseComplete event should carry a plan_file path
        if result.is_ok() {
            let captured = events.lock().unwrap();
            let design_complete = captured
                .iter()
                .find(|e| matches!(e, SessionEvent::DesignPhaseComplete { .. }));
            assert!(
                design_complete.is_some(),
                "should emit DesignPhaseComplete on success"
            );
            match design_complete.unwrap() {
                SessionEvent::DesignPhaseComplete { plan_file } => {
                    assert!(
                        !plan_file.is_empty(),
                        "plan_file should not be empty in DesignPhaseComplete"
                    );
                }
                _ => unreachable!(),
            }
        }
    }

    #[test]
    fn test_oneshot_emit_persists_events_to_disk() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config(&tmp, MergeStrategy::Branch);
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = CancellationToken::new();

        let runner = OneShotRunner::new(config, collector, cancel_token);

        // Set the session_id so emit() will persist events via TraceCollector::append_event
        let test_session_id = "test-session-abc123".to_string();
        *runner.session_id.lock().unwrap() = Some(test_session_id.clone());

        // Emit a few events
        let events_to_emit = vec![
            SessionEvent::OneShotStarted {
                title: "Add login feature".to_string(),
                merge_strategy: "branch".to_string(),
            },
            SessionEvent::DesignPhaseStarted,
            SessionEvent::DesignPhaseComplete {
                plan_file: "/tmp/plan.md".to_string(),
            },
        ];

        for event in &events_to_emit {
            runner.emit(event.clone());
        }

        // Read back from disk using TraceCollector::read_events
        let persisted_events =
            TraceCollector::read_events(tmp.path(), "test-repo", &test_session_id)
                .expect("should read persisted events from disk");

        // Verify all emitted events were persisted
        assert_eq!(
            persisted_events.len(),
            events_to_emit.len(),
            "should have persisted {} events, got {}",
            events_to_emit.len(),
            persisted_events.len()
        );

        // Verify event contents by serializing and comparing (SessionEvent may not impl PartialEq)
        let persisted_json: Vec<String> = persisted_events
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect();
        let expected_json: Vec<String> = events_to_emit
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect();
        assert_eq!(
            persisted_json, expected_json,
            "persisted events should match emitted events"
        );

        // Also verify the in-memory accumulated_events captured them
        let accumulated = runner.accumulated_events.lock().unwrap();
        assert_eq!(
            accumulated.len(),
            events_to_emit.len(),
            "accumulated_events should also have {} events",
            events_to_emit.len()
        );
    }

    #[tokio::test]
    async fn test_oneshot_trace_has_oneshot_session_type() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, _events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "Branch pushed".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;
        if let Ok(trace) = result {
            assert_eq!(
                trace.session_type, "one_shot",
                "session_type should be 'one_shot' for oneshot sessions"
            );
        }
    }
}
