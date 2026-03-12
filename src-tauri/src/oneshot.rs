use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use tokio_util::sync::CancellationToken;

use crate::git_merge::{git_merge_push, GitMergeConfig, GitMergeEvent};
use crate::prompt;
use crate::runtime::RuntimeProvider;
use crate::session::{AbortRegistry, GitSyncConfig, OnSessionEvent, SessionConfig, SessionEvent, SessionRunner};
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
    pub max_iterations: u32,
    pub completion_signal: String,
    pub checks: Vec<crate::session::Check>,
    pub git_sync: Option<crate::session::GitSyncConfig>,
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

/// Generate a unique oneshot ID in format "oneshot-XXXXXX" (6 hex chars)
pub fn generate_oneshot_id() -> String {
    let short = generate_short_id();
    format!("oneshot-{}", short)
}

/// Extract a plan file path from a list of SessionEvents.
/// Looks for ToolUse events with Write/Edit tools that target docs/plans/*.md or *-design.md paths.
pub fn extract_plan_file_from_events(events: &[SessionEvent]) -> Option<String> {
    for event in events {
        if let SessionEvent::ToolUse { tool_name, tool_input, .. } = event {
            if tool_name == "Write" || tool_name == "Edit" {
                if let Some(input) = tool_input {
                    if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
                        if (file_path.contains("docs/plans/") && file_path.ends_with(".md"))
                            || file_path.ends_with("-design.md")
                        {
                            return Some(file_path.to_string());
                        }
                    }
                }
            }
        }
    }
    None
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

/// Compute the branch name: `oneshot/<slug>-<short_id>`
pub fn branch_name(slug: &str, short_id: &str) -> String {
    format!("oneshot/{}-{}", slug, short_id)
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
    on_event: Option<Arc<dyn Fn(&SessionEvent) + Send + Sync>>,
    abort_registry: Option<AbortRegistry>,
    accumulated_events: Arc<std::sync::Mutex<Vec<SessionEvent>>>,
    session_id: Arc<std::sync::Mutex<Option<String>>>,
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
            accumulated_events: Arc::new(std::sync::Mutex::new(Vec::new())),
            session_id: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn on_event(mut self, cb: OnSessionEvent) -> Self {
        self.on_event = Some(Arc::from(cb));
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

    /// Create an event-forwarding callback that routes inner SessionRunner events
    /// through this OneShotRunner's emit system (accumulate + persist + forward).
    fn make_event_forwarder(&self) -> OnSessionEvent {
        let accumulated = self.accumulated_events.clone();
        let session_id = self.session_id.clone();
        let collector = self.collector.clone();
        let on_event_cb = self.on_event.clone();

        Box::new(move |event: &SessionEvent| {
            accumulated.lock().unwrap().push(event.clone());
            if let Some(ref sid) = *session_id.lock().unwrap() {
                if let Err(e) = collector.append_event(sid, event) {
                    tracing::warn!("Failed to append event to disk: {e}");
                }
            }
            if let Some(ref cb) = on_event_cb {
                cb(event);
            }
        })
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
            parent_repo_id: self.config.repo_id.clone(),
            prompt: self.config.prompt.clone(),
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

        // Collect design events separately so we can extract plan file from them
        let design_events: Arc<std::sync::Mutex<Vec<SessionEvent>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));
        let design_events_clone = design_events.clone();

        let design_config = SessionConfig {
            repo_path: self.config.repo_path.clone(),
            working_dir: Some(wt_path.clone()),
            prompt: design_prompt,
            max_iterations: 1,
            completion_signal: String::new(),
            model: Some(self.config.model.clone()),
            extra_args: vec!["--dangerously-skip-permissions".to_string()],
            env_vars: self.config.env_vars.clone(),
            checks: vec![],
            git_sync: None,
            ..SessionConfig::default()
        };

        let design_collector = TraceCollector::new(&self.config.repo_path, &self.config.repo_id);

        // Create a forwarding callback that also collects design events
        let forwarder = self.make_event_forwarder();
        let design_cb: OnSessionEvent = Box::new(move |event: &SessionEvent| {
            design_events_clone.lock().unwrap().push(event.clone());
            forwarder(event);
        });

        let design_runner = SessionRunner::new(design_config, design_collector, self.cancel_token.clone())
            .on_event(design_cb);
        let design_runner = if let Some(ref registry) = self.abort_registry {
            design_runner.abort_registry(registry.clone())
        } else {
            design_runner
        };

        tracing::info!("Starting design phase for '{}'", self.config.title);
        design_runner.run_with_trace(runtime, &mut trace).await?;

        // Check design phase outcome
        match trace.outcome {
            SessionOutcome::Failed => {
                let reason = trace.failure_reason.clone().unwrap_or_else(|| "Design phase failed".to_string());
                self.cleanup_worktree(runtime, &wt_path).await;
                self.emit(SessionEvent::OneShotFailed {
                    reason: format!("Design phase failed: {}", reason),
                });
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                let _ = self.collector.finalize(&mut trace, &events).await;
                return Err(anyhow::anyhow!("Design phase failed"));
            }
            SessionOutcome::Cancelled => {
                self.cleanup_worktree(runtime, &wt_path).await;
                self.emit(SessionEvent::OneShotFailed {
                    reason: "Cancelled".to_string(),
                });
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                let _ = self.collector.finalize(&mut trace, &events).await;
                return Err(anyhow::anyhow!("Cancelled"));
            }
            _ => {
                // Completed or MaxIterationsReached — both OK for design phase
            }
        }

        // Extract plan file from design events
        let design_evts = design_events.lock().unwrap().clone();
        let plan_file_from_events = extract_plan_file_from_events(&design_evts);
        tracing::debug!("Plan file from events extraction: {:?}", plan_file_from_events);

        // Also try text-based extraction as fallback
        let mut collected_text = String::new();
        for event in &design_evts {
            if let SessionEvent::AssistantText { text, .. } = event {
                collected_text.push_str(text);
            }
        }
        let plan_file_from_text = self.extract_plan_file_from_output(&collected_text);
        tracing::debug!("Plan file from text extraction: {:?}", plan_file_from_text);

        // Determine the plan file path
        let plan_file_path = if let Some(p) = plan_file_from_events {
            tracing::info!("Using plan file from events: {}", p);
            // Make path relative if it's absolute and within the worktree
            let wt_prefix = format!("{}/", wt_path.display());
            if p.starts_with(&wt_prefix) {
                p[wt_prefix.len()..].to_string()
            } else {
                p
            }
        } else if let Some(p) = plan_file_from_text {
            tracing::info!("Using plan file from text: {}", p);
            p
        } else if collected_text.contains("<promise>COMPLETE</promise>") {
            tracing::warn!(
                "Design phase claimed COMPLETE but no plan file found. text_len={}",
                collected_text.len(),
            );
            self.cleanup_worktree(runtime, &wt_path).await;
            self.emit(SessionEvent::OneShotFailed {
                reason: format!(
                    "Design phase did not produce a plan file. \
                     Claude output {} chars of text.",
                    collected_text.len(),
                ),
            });
            trace.outcome = SessionOutcome::Failed;
            trace.end_time = Some(Utc::now());
            let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
            let _ = self.collector.finalize(&mut trace, &events).await;
            return Err(anyhow::anyhow!("Design phase did not produce a plan file"));
        } else {
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

        // Reset trace outcome for implementation phase
        trace.outcome = SessionOutcome::Running;
        trace.failure_reason = None;

        let plan_file_abs = format!("{}/{}", wt_path.display(), plan_file_path);
        let impl_prompt = prompt::build_prompt(&plan_file_abs);

        let impl_config = SessionConfig {
            repo_path: self.config.repo_path.clone(),
            working_dir: Some(wt_path.clone()),
            prompt: impl_prompt,
            max_iterations: self.config.max_iterations,
            completion_signal: self.config.completion_signal.clone(),
            model: Some(self.config.model.clone()),
            extra_args: vec!["--dangerously-skip-permissions".to_string()],
            env_vars: self.config.env_vars.clone(),
            checks: self.config.checks.clone(),
            git_sync: self.config.git_sync.clone(),
            // Offset by 1 so implementation iterations start at 2 (design is iteration 1)
            iteration_offset: 1,
            ..SessionConfig::default()
        };

        let impl_collector = TraceCollector::new(&self.config.repo_path, &self.config.repo_id);
        let impl_forwarder = self.make_event_forwarder();

        let impl_runner = SessionRunner::new(impl_config, impl_collector, self.cancel_token.clone())
            .on_event(impl_forwarder);
        let impl_runner = if let Some(ref registry) = self.abort_registry {
            impl_runner.abort_registry(registry.clone())
        } else {
            impl_runner
        };

        tracing::info!("Starting implementation phase");
        impl_runner.run_with_trace(runtime, &mut trace).await?;

        // Check implementation phase outcome
        match trace.outcome {
            SessionOutcome::Failed => {
                let reason = trace.failure_reason.clone().unwrap_or_else(|| "Implementation phase failed".to_string());
                self.cleanup_worktree(runtime, &wt_path).await;
                self.emit(SessionEvent::OneShotFailed {
                    reason: format!("Implementation phase failed: {}", reason),
                });
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                let _ = self.collector.finalize(&mut trace, &events).await;
                return Err(anyhow::anyhow!("Implementation phase failed"));
            }
            SessionOutcome::Cancelled => {
                self.cleanup_worktree(runtime, &wt_path).await;
                self.emit(SessionEvent::OneShotFailed {
                    reason: "Cancelled".to_string(),
                });
                trace.end_time = Some(Utc::now());
                let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                let _ = self.collector.finalize(&mut trace, &events).await;
                return Err(anyhow::anyhow!("Cancelled"));
            }
            _ => {
                // Completed or MaxIterationsReached — OK
            }
        }

        self.emit(SessionEvent::ImplementationPhaseComplete);

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
                // Use shared git_merge_push for robust merge-with-retry logic.
                // This handles fetch, rebase, conflict resolution via Claude,
                // and push retries automatically.
                let push_cmd = format!("git push origin {}:main", branch);
                let fetch_cmd = "git fetch origin main".to_string();
                let rebase_cmd = "git rebase origin/main".to_string();

                let git_sync_config = self.config.git_sync.clone().unwrap_or(GitSyncConfig {
                    enabled: true,
                    conflict_prompt: None,
                    model: None,
                    max_push_retries: 3,
                });

                let merge_config = GitMergeConfig {
                    working_dir: &wt_path,
                    push_command: &push_cmd,
                    fetch_command: &fetch_cmd,
                    rebase_command: &rebase_cmd,
                    push_u_command: None,
                    conflict_prompt: git_sync_config.conflict_prompt.as_deref(),
                    conflict_model: git_sync_config.model.clone().or(Some("sonnet".to_string())),
                    max_retries: git_sync_config.max_push_retries,
                    cancel_token: &self.cancel_token,
                    env_vars: &self.config.env_vars,
                };

                let iteration = u32::MAX;
                let merge_result = git_merge_push(runtime, &merge_config, |event| {
                    match event {
                        GitMergeEvent::PushSucceeded => {
                            self.emit(SessionEvent::GitSyncPushSucceeded { iteration });
                        }
                        GitMergeEvent::ConflictDetected { files } => {
                            self.emit(SessionEvent::GitSyncConflict { iteration, files });
                        }
                        GitMergeEvent::ConflictResolveStarted { attempt } => {
                            self.emit(SessionEvent::GitSyncConflictResolveStarted { iteration, attempt });
                        }
                        GitMergeEvent::ConflictResolveComplete { attempt, success } => {
                            self.emit(SessionEvent::GitSyncConflictResolveComplete { iteration, attempt, success });
                        }
                        GitMergeEvent::Failed { error } => {
                            self.emit(SessionEvent::GitSyncFailed { iteration, error });
                        }
                    }
                }).await;

                if let Err(err) = merge_result {
                    self.emit(SessionEvent::OneShotFailed {
                        reason: format!(
                            "Merge to main failed: {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree, rebase manually, then push. Once done, remove the worktree with:\ngit worktree remove {}",
                            err, branch, wt_path.display(), wt_path.display()
                        ),
                    });
                    trace.outcome = SessionOutcome::Failed;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Merge to main failed"));
                }

                // Clean up: delete branch and remove worktree
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
                // Use shared git_merge_push for robust push-with-retry logic.
                let push_cmd = format!("git push origin {}", branch);
                let push_u_cmd = format!("git push -u origin {}", branch);
                let fetch_cmd = format!("git fetch origin {}", branch);
                let rebase_cmd = format!("git pull --rebase origin {}", branch);

                let git_sync_config = self.config.git_sync.clone().unwrap_or(GitSyncConfig {
                    enabled: true,
                    conflict_prompt: None,
                    model: None,
                    max_push_retries: 3,
                });

                let merge_config = GitMergeConfig {
                    working_dir: &wt_path,
                    push_command: &push_cmd,
                    fetch_command: &fetch_cmd,
                    rebase_command: &rebase_cmd,
                    push_u_command: Some(&push_u_cmd),
                    conflict_prompt: git_sync_config.conflict_prompt.as_deref(),
                    conflict_model: git_sync_config.model.clone().or(Some("sonnet".to_string())),
                    max_retries: git_sync_config.max_push_retries,
                    cancel_token: &self.cancel_token,
                    env_vars: &self.config.env_vars,
                };

                let iteration = u32::MAX;
                let merge_result = git_merge_push(runtime, &merge_config, |event| {
                    match event {
                        GitMergeEvent::PushSucceeded => {
                            self.emit(SessionEvent::GitSyncPushSucceeded { iteration });
                        }
                        GitMergeEvent::ConflictDetected { files } => {
                            self.emit(SessionEvent::GitSyncConflict { iteration, files });
                        }
                        GitMergeEvent::ConflictResolveStarted { attempt } => {
                            self.emit(SessionEvent::GitSyncConflictResolveStarted { iteration, attempt });
                        }
                        GitMergeEvent::ConflictResolveComplete { attempt, success } => {
                            self.emit(SessionEvent::GitSyncConflictResolveComplete { iteration, attempt, success });
                        }
                        GitMergeEvent::Failed { error } => {
                            self.emit(SessionEvent::GitSyncFailed { iteration, error });
                        }
                    }
                }).await;

                if let Err(err) = merge_result {
                    self.emit(SessionEvent::OneShotFailed {
                        reason: format!(
                            "Push to branch failed: {}\n\nYour work is preserved on branch `{}` in the worktree at:\n{}\n\nTo resolve, cd into the worktree, pull/rebase, then push manually. Once done, remove the worktree with:\ngit worktree remove {}",
                            err, branch, wt_path.display(), wt_path.display()
                        ),
                    });
                    trace.outcome = SessionOutcome::Failed;
                    trace.end_time = Some(Utc::now());
                    let events: Vec<SessionEvent> = self.accumulated_events.lock().unwrap().clone();
                    let _ = self.collector.finalize(&mut trace, &events).await;
                    return Err(anyhow::anyhow!("Push to branch failed"));
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{CommandOutput, MockRuntime};
    use crate::session::{Check, CheckWhen, GitSyncConfig, SessionEvent};
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
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            checks: Vec::new(),
            git_sync: None,
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
            max_iterations: 15,
            completion_signal: "DONE".to_string(),
            checks: vec![Check {
                name: "lint".to_string(),
                command: "npm run lint".to_string(),
                when: CheckWhen::EachIteration,
                prompt: None,
                model: None,
                timeout_secs: 60,
                max_retries: 3,
            }],
            git_sync: Some(GitSyncConfig {
                enabled: true,
                conflict_prompt: None,
                model: None,
                max_push_retries: 3,
            }),
        };

        assert_eq!(config.repo_id, "repo-123");
        assert_eq!(config.repo_path, PathBuf::from("/home/user/project"));
        assert_eq!(config.title, "Implement OAuth");
        assert_eq!(config.prompt, "Add OAuth2 support with Google provider");
        assert_eq!(config.model, "claude-opus");
        assert_eq!(config.merge_strategy, MergeStrategy::MergeToMain);
        assert_eq!(config.env_vars.get("API_KEY"), Some(&"test-key".to_string()));
        assert_eq!(config.max_iterations, 15);
        assert_eq!(config.completion_signal, "DONE");
        assert_eq!(config.checks.len(), 1);
        assert_eq!(config.checks[0].name, "lint");
        assert!(config.git_sync.is_some());
        assert!(config.git_sync.as_ref().unwrap().enabled);
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
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            checks: Vec::new(),
            git_sync: None,
        };

        assert_eq!(config.merge_strategy, MergeStrategy::Branch);
        assert!(config.env_vars.is_empty());
        assert_eq!(config.max_iterations, 10);
        assert_eq!(config.completion_signal, "<promise>COMPLETE</promise>");
        assert!(config.checks.is_empty());
        assert!(config.git_sync.is_none());
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

        // Verify OneShotStarted contains the title, parent_repo_id, prompt, and strategy
        match &captured[started_idx] {
            SessionEvent::OneShotStarted {
                title,
                parent_repo_id,
                prompt,
                merge_strategy,
            } => {
                assert_eq!(title, "Add login feature");
                assert_eq!(parent_repo_id, "test-repo");
                assert_eq!(prompt, "Implement user login with email and password");
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

        // Verify iteration events appear between DesignPhaseStarted and DesignPhaseComplete
        let design_events: Vec<&SessionEvent> = captured[design_started_idx + 1..design_complete_idx].iter().collect();
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::IterationStarted { .. })),
            "design phase should contain IterationStarted events, got: {:?}",
            design_events
        );
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::ToolUse { .. })),
            "design phase should contain ToolUse events, got: {:?}",
            design_events
        );
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::AssistantText { .. })),
            "design phase should contain AssistantText events, got: {:?}",
            design_events
        );
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::IterationComplete { .. })),
            "design phase should contain IterationComplete events, got: {:?}",
            design_events
        );

        // Verify iteration events appear between ImplementationPhaseStarted and ImplementationPhaseComplete
        let impl_events: Vec<&SessionEvent> = captured[impl_started_idx + 1..impl_complete_idx].iter().collect();
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::IterationStarted { .. })),
            "implementation phase should contain IterationStarted events, got: {:?}",
            impl_events
        );
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::ToolUse { .. })),
            "implementation phase should contain ToolUse events, got: {:?}",
            impl_events
        );
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::AssistantText { .. })),
            "implementation phase should contain AssistantText events, got: {:?}",
            impl_events
        );
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::IterationComplete { .. })),
            "implementation phase should contain IterationComplete events, got: {:?}",
            impl_events
        );

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

        // Verify OneShotStarted shows "branch" strategy with parent_repo_id and prompt
        let started_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotStarted { .. }));
        assert!(
            started_event.is_some(),
            "should have OneShotStarted event"
        );
        match started_event.unwrap() {
            SessionEvent::OneShotStarted {
                title,
                parent_repo_id,
                prompt,
                merge_strategy,
            } => {
                assert_eq!(title, "Add login feature");
                assert_eq!(parent_repo_id, "test-repo");
                assert_eq!(prompt, "Implement user login with email and password");
                assert_eq!(merge_strategy, "branch");
            }
            _ => unreachable!(),
        }

        // Verify iteration events appear between design phase markers
        let design_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::DesignPhaseStarted))
            .expect("should have DesignPhaseStarted");
        let design_complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::DesignPhaseComplete { .. }))
            .expect("should have DesignPhaseComplete");
        let design_events: Vec<&SessionEvent> = captured[design_started_idx + 1..design_complete_idx].iter().collect();
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::IterationStarted { .. })),
            "design phase should contain IterationStarted events, got: {:?}",
            design_events
        );
        assert!(
            design_events.iter().any(|e| matches!(e, SessionEvent::IterationComplete { .. })),
            "design phase should contain IterationComplete events, got: {:?}",
            design_events
        );

        // Verify iteration events appear between implementation phase markers
        let impl_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::ImplementationPhaseStarted))
            .expect("should have ImplementationPhaseStarted");
        let impl_complete_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::ImplementationPhaseComplete))
            .expect("should have ImplementationPhaseComplete");
        let impl_events: Vec<&SessionEvent> = captured[impl_started_idx + 1..impl_complete_idx].iter().collect();
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::IterationStarted { .. })),
            "implementation phase should contain IterationStarted events, got: {:?}",
            impl_events
        );
        assert!(
            impl_events.iter().any(|e| matches!(e, SessionEvent::IterationComplete { .. })),
            "implementation phase should contain IterationComplete events, got: {:?}",
            impl_events
        );

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

        // Command results for the git_merge_push flow:
        // 1. mkdir -p (success)
        // 2. git worktree add (success)
        // --- git_merge_push begins ---
        // 3. git push (optimistic) — FAIL (rejected)
        // --- retry loop attempt 1/3 ---
        // 4. git fetch origin main — success
        // 5. git rebase origin/main — FAIL (non-conflict, e.g. diverged)
        // 6. git status — no "Unmerged paths" (not a conflict)
        // 7. git rebase --abort
        // --- retry loop attempt 2/3 ---
        // 8. git fetch origin main — success
        // 9. git rebase origin/main — FAIL again
        // 10. git status — no "Unmerged paths"
        // 11. git rebase --abort
        // --- retry loop attempt 3/3 ---
        // 12. git fetch origin main — success
        // 13. git rebase origin/main — FAIL again
        // 14. git status — no "Unmerged paths"
        // 15. git rebase --abort
        // --- git_merge_push returns Err (all retries exhausted) ---
        runtime.command_results = vec![
            // 1. mkdir -p
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git worktree add
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // 3. git push (optimistic) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 4. git fetch (attempt 1) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. git rebase (attempt 1) — FAIL (non-conflict)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: cannot rebase".to_string(),
            },
            // 6. git status (conflict check) — no conflict markers
            CommandOutput {
                exit_code: 0,
                stdout: "On branch oneshot/test\nnothing to commit".to_string(),
                stderr: String::new(),
            },
            // 7. git rebase --abort
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 8. git fetch (attempt 2) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 9. git rebase (attempt 2) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: cannot rebase".to_string(),
            },
            // 10. git status — no conflict
            CommandOutput {
                exit_code: 0,
                stdout: "On branch oneshot/test\nnothing to commit".to_string(),
                stderr: String::new(),
            },
            // 11. git rebase --abort
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 12. git fetch (attempt 3) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 13. git rebase (attempt 3) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: cannot rebase".to_string(),
            },
            // 14. git status — no conflict
            CommandOutput {
                exit_code: 0,
                stdout: "On branch oneshot/test\nnothing to commit".to_string(),
                stderr: String::new(),
            },
            // 15. git rebase --abort
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

        // Should have OneShotFailed (due to rebase failure after all retries)
        let failed_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed_event.is_some(),
            "should emit OneShotFailed when rebase fails, events: {:?}",
            *captured
        );

        // Verify the failure reason mentions the merge failure and worktree path
        if let Some(SessionEvent::OneShotFailed { reason }) = failed_event {
            assert!(
                reason.contains("rebase") || reason.contains("Merge") || reason.contains("failed"),
                "failure reason should mention rebase/merge failure, got: {}",
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
                parent_repo_id: "test-repo".to_string(),
                prompt: "Implement user login with email and password".to_string(),
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

    // =========================================================================
    // generate_oneshot_id tests
    // =========================================================================

    #[test]
    fn test_oneshot_id_generation_format() {
        let id = generate_oneshot_id();
        assert!(
            id.starts_with("oneshot-"),
            "oneshot id should start with 'oneshot-', got: '{}'",
            id
        );
        let suffix = &id["oneshot-".len()..];
        assert_eq!(
            suffix.len(),
            6,
            "oneshot id suffix should be 6 chars, got {} chars: '{}'",
            suffix.len(),
            suffix
        );
        assert!(
            suffix.chars().all(|c| c.is_ascii_hexdigit()),
            "oneshot id suffix should be hex chars, got: '{}'",
            suffix
        );
    }

    #[test]
    fn test_oneshot_id_generation_uniqueness() {
        let id1 = generate_oneshot_id();
        let id2 = generate_oneshot_id();
        assert_ne!(
            id1, id2,
            "two calls to generate_oneshot_id should produce different values"
        );
    }

    // =========================================================================
    // extract_plan_file_from_events tests
    // =========================================================================

    #[test]
    fn test_extract_plan_file_from_tool_events_write_docs_plans() {
        let events = vec![
            SessionEvent::IterationStarted { iteration: 1 },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Write".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "docs/plans/2026-03-10-feature-design.md",
                    "content": "# Design\n..."
                })),
            },
            SessionEvent::IterationComplete {
                iteration: 1,
                result: crate::output::ResultEvent {
                    subtype: None,
                    is_error: false,
                    duration_ms: None,
                    duration_api_ms: None,
                    num_turns: None,
                    result: None,
                    session_id: None,
                    total_cost_usd: None,
                    stop_reason: None,
                    usage: None,
                    model_usage: None,
                },
            },
        ];
        let plan_file = extract_plan_file_from_events(&events);
        assert_eq!(
            plan_file,
            Some("docs/plans/2026-03-10-feature-design.md".to_string()),
            "should extract plan file from Write tool_use with docs/plans/ path"
        );
    }

    #[test]
    fn test_extract_plan_file_from_tool_events_edit_design_md() {
        let events = vec![
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Edit".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "my-feature-design.md",
                    "old_string": "old",
                    "new_string": "new"
                })),
            },
        ];
        let plan_file = extract_plan_file_from_events(&events);
        assert_eq!(
            plan_file,
            Some("my-feature-design.md".to_string()),
            "should extract plan file from Edit tool_use with *-design.md path"
        );
    }

    #[test]
    fn test_extract_plan_file_from_tool_events_unrelated_path() {
        let events = vec![
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Write".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "src/main.rs",
                    "content": "fn main() {}"
                })),
            },
        ];
        let plan_file = extract_plan_file_from_events(&events);
        assert!(
            plan_file.is_none(),
            "should return None for unrelated file paths, got: {:?}",
            plan_file
        );
    }

    #[test]
    fn test_extract_plan_file_from_tool_events_multiple_only_one_plan() {
        let events = vec![
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Read".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "src/lib.rs"
                })),
            },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Write".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "src/helper.rs",
                    "content": "// helper"
                })),
            },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Write".to_string(),
                tool_input: Some(serde_json::json!({
                    "file_path": "docs/plans/2026-03-10-login-design.md",
                    "content": "# Login Design"
                })),
            },
            SessionEvent::AssistantText {
                iteration: 1,
                text: "Done writing the plan.".to_string(),
            },
        ];
        let plan_file = extract_plan_file_from_events(&events);
        assert_eq!(
            plan_file,
            Some("docs/plans/2026-03-10-login-design.md".to_string()),
            "should extract the plan file path from among multiple ToolUse events"
        );
    }

    // =========================================================================
    // OneShotConfig with implementation fields test
    // =========================================================================

    #[test]
    fn test_oneshot_config_with_impl_fields() {
        let config = OneShotConfig {
            repo_id: "repo-789".to_string(),
            repo_path: PathBuf::from("/home/user/project"),
            title: "Add feature X".to_string(),
            prompt: "Implement feature X".to_string(),
            model: "claude-sonnet".to_string(),
            merge_strategy: MergeStrategy::Branch,
            env_vars: HashMap::new(),
            max_iterations: 20,
            completion_signal: "ALL_DONE".to_string(),
            checks: vec![
                Check {
                    name: "lint".to_string(),
                    command: "npm run lint".to_string(),
                    when: CheckWhen::EachIteration,
                    prompt: None,
                    model: None,
                    timeout_secs: 60,
                    max_retries: 3,
                },
                Check {
                    name: "test".to_string(),
                    command: "cargo test".to_string(),
                    when: CheckWhen::PostCompletion,
                    prompt: Some("Fix failing tests".to_string()),
                    model: Some("claude-opus".to_string()),
                    timeout_secs: 300,
                    max_retries: 5,
                },
            ],
            git_sync: Some(GitSyncConfig {
                enabled: true,
                conflict_prompt: Some("Resolve merge conflicts".to_string()),
                model: Some("claude-sonnet".to_string()),
                max_push_retries: 5,
            }),
        };

        assert_eq!(config.max_iterations, 20);
        assert_eq!(config.completion_signal, "ALL_DONE");
        assert_eq!(config.checks.len(), 2);
        assert_eq!(config.checks[0].name, "lint");
        assert_eq!(config.checks[1].name, "test");
        assert_eq!(config.checks[1].max_retries, 5);

        let git_sync = config.git_sync.as_ref().unwrap();
        assert!(git_sync.enabled);
        assert_eq!(
            git_sync.conflict_prompt,
            Some("Resolve merge conflicts".to_string())
        );
        assert_eq!(
            git_sync.model,
            Some("claude-sonnet".to_string())
        );
        assert_eq!(git_sync.max_push_retries, 5);
    }

    // =========================================================================
    // MergeToMain with git_merge_push integration tests
    // =========================================================================

    /// Test that when the merge-to-main flow encounters a rebase conflict,
    /// Claude resolves it successfully, the push succeeds, and the correct
    /// GitSync* events are emitted during the finalize phase.
    #[tokio::test]
    async fn test_oneshot_merge_to_main_with_conflict_resolution() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::MergeToMain);

        // completing_after(1) gives 2 scenarios (design + implementation).
        // The mock reuses the last scenario when exhausted, so the 3rd
        // spawn_claude call (conflict resolution inside git_merge_push)
        // will also get a completing scenario. That's fine.
        let mut runtime = MockRuntime::completing_after(1);

        // Command sequence:
        // 1. mkdir -p (worktree parent dir)               -> success
        // 2. git worktree add                              -> success
        //    [design phase — spawn_claude #1]
        //    [implementation phase — spawn_claude #2]
        // --- git_merge_push begins ---
        // 3. git push origin {branch}:main (optimistic)   -> FAIL (rejected)
        // --- retry loop attempt 1 ---
        // 4. git fetch origin main                         -> success
        // 5. git rebase origin/main                        -> FAIL (conflict)
        // 6. git status (conflict check)                   -> "Unmerged paths" + "both modified"
        // 7. git diff --name-only --diff-filter=U          -> conflict file list
        //    [conflict resolution — spawn_claude #3]
        // 8. git status (post-resolution check)            -> clean (no "rebase in progress")
        // 9. git push origin {branch}:main (after resolve) -> success
        // --- git_merge_push ends ---
        // 10. git branch -d {branch}                       -> success
        // 11. git worktree remove                          -> success
        runtime.command_results = vec![
            // 1. mkdir -p
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git worktree add
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // 3. git push (optimistic) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 4. git fetch origin main — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. git rebase origin/main — FAIL (conflict)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "CONFLICT (content): Merge conflict in src/main.rs".to_string(),
            },
            // 6. git status — shows unmerged paths
            CommandOutput {
                exit_code: 0,
                stdout: "Unmerged paths:\n  both modified: src/main.rs".to_string(),
                stderr: String::new(),
            },
            // 7. git diff --name-only --diff-filter=U — conflict file list
            CommandOutput {
                exit_code: 0,
                stdout: "src/main.rs\n".to_string(),
                stderr: String::new(),
            },
            // [spawn_claude #3 for conflict resolution happens here]
            // 8. git status (post-resolution) — clean, no "rebase in progress"
            CommandOutput {
                exit_code: 0,
                stdout: "On branch oneshot/add-login-feature\nnothing to commit".to_string(),
                stderr: String::new(),
            },
            // 9. git push (after conflict resolution) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 10. git branch -d
            CommandOutput {
                exit_code: 0,
                stdout: "Deleted branch".to_string(),
                stderr: String::new(),
            },
            // 11. git worktree remove
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;
        assert!(
            result.is_ok(),
            "run should succeed after conflict resolution, got: {:?}",
            result.err()
        );

        let captured = events.lock().unwrap();

        // Verify GitFinalizeStarted is present
        let finalize_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. }))
            .expect("should have GitFinalizeStarted");

        // All GitSync* events should appear AFTER GitFinalizeStarted
        let events_after_finalize = &captured[finalize_started_idx..];

        // Verify GitSyncConflict event with file list
        assert!(
            events_after_finalize.iter().any(|e| matches!(
                e,
                SessionEvent::GitSyncConflict { files, .. } if files.contains(&"src/main.rs".to_string())
            )),
            "should emit GitSyncConflict with conflict files after GitFinalizeStarted, got: {:?}",
            events_after_finalize
        );

        // Verify GitSyncConflictResolveStarted
        assert!(
            events_after_finalize
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncConflictResolveStarted { .. })),
            "should emit GitSyncConflictResolveStarted after GitFinalizeStarted, got: {:?}",
            events_after_finalize
        );

        // Verify GitSyncConflictResolveComplete with success=true
        assert!(
            events_after_finalize.iter().any(|e| matches!(
                e,
                SessionEvent::GitSyncConflictResolveComplete { success, .. } if *success
            )),
            "should emit GitSyncConflictResolveComplete(success=true) after GitFinalizeStarted, got: {:?}",
            events_after_finalize
        );

        // Verify GitSyncPushSucceeded
        assert!(
            events_after_finalize
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. })),
            "should emit GitSyncPushSucceeded after GitFinalizeStarted, got: {:?}",
            events_after_finalize
        );

        // Verify OneShotComplete is present
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should emit OneShotComplete after successful conflict resolution, got: {:?}",
            *captured
        );

        // Should NOT have OneShotFailed
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotFailed { .. })),
            "should not emit OneShotFailed on success"
        );
    }

    /// Test that when the merge-to-main flow exhausts all push retries,
    /// OneShotFailed is emitted, the worktree is NOT cleaned up, and
    /// OneShotComplete is NOT emitted.
    #[tokio::test]
    async fn test_oneshot_merge_to_main_all_retries_fail() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::MergeToMain);

        let mut runtime = MockRuntime::completing_after(1);

        // Command sequence:
        // 1. mkdir -p (worktree parent dir)               -> success
        // 2. git worktree add                              -> success
        //    [design phase — spawn_claude #1]
        //    [implementation phase — spawn_claude #2]
        // --- git_merge_push begins ---
        // 3. git push origin {branch}:main (optimistic)   -> FAIL
        // --- retry loop attempt 1/3 ---
        // 4. git fetch origin main                         -> success
        // 5. git rebase origin/main                        -> success
        // 6. git push origin {branch}:main                 -> FAIL
        // --- retry loop attempt 2/3 ---
        // 7. git fetch origin main                         -> success
        // 8. git rebase origin/main                        -> success
        // 9. git push origin {branch}:main                 -> FAIL
        // --- retry loop attempt 3/3 ---
        // 10. git fetch origin main                        -> success
        // 11. git rebase origin/main                       -> success
        // 12. git push origin {branch}:main                -> FAIL
        // --- git_merge_push returns Err (all retries exhausted) ---
        // NO git branch -d or git worktree remove should follow
        runtime.command_results = vec![
            // 1. mkdir -p
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git worktree add
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // 3. git push (optimistic) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 4. git fetch (attempt 1) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. git rebase (attempt 1) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 6. git push (attempt 1) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
            // 7. git fetch (attempt 2) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 8. git rebase (attempt 2) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 9. git push (attempt 2) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
            // 10. git fetch (attempt 3) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 11. git rebase (attempt 3) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 12. git push (attempt 3) — FAIL (last retry)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: remote has changed".to_string(),
            },
            // If the implementation incorrectly tries to clean up after failure,
            // it would consume more commands from the mock. Since MockRuntime
            // repeats the last result when exhausted (exit_code: 1), any
            // additional cleanup commands would get a failure result. The test
            // verifies correctness through event assertions below.
        ];

        let _result = runner.run(&runtime).await;

        let captured = events.lock().unwrap();

        // Verify OneShotFailed is emitted with a message about push failure
        let failed_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed_event.is_some(),
            "should emit OneShotFailed when all retries are exhausted, events: {:?}",
            *captured
        );
        if let Some(SessionEvent::OneShotFailed { reason }) = failed_event {
            assert!(
                reason.to_lowercase().contains("push")
                    || reason.to_lowercase().contains("retries")
                    || reason.to_lowercase().contains("failed"),
                "OneShotFailed reason should mention push failure, got: {}",
                reason
            );
        }

        // Verify OneShotComplete is NOT emitted
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should not emit OneShotComplete when all retries fail"
        );

        // Verify GitFinalizeStarted was emitted (we did enter the finalize phase)
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. })),
            "should emit GitFinalizeStarted even when push eventually fails, events: {:?}",
            *captured
        );

        // Verify GitFinalizeComplete is NOT emitted (finalize did not succeed)
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeComplete)),
            "should not emit GitFinalizeComplete when push fails after all retries"
        );

        // Verify the OneShotFailed reason specifically mentions push failure
        // after retries (not a fetch or rebase failure). The new git_merge_push
        // returns an error like "push failed after all retries: ..." which the
        // oneshot runner wraps in the OneShotFailed event.
        if let Some(SessionEvent::OneShotFailed { reason }) = failed_event {
            let reason_lower = reason.to_lowercase();
            assert!(
                reason_lower.contains("push failed after all retries")
                    || reason_lower.contains("push failed"),
                "OneShotFailed reason should contain 'push failed after all retries' (from git_merge_push retry exhaustion), got: {}",
                reason
            );
        }
    }

    // =========================================================================
    // Branch strategy with git_merge_push integration tests
    // =========================================================================

    /// Test that when the Branch strategy's initial push fails, the retry loop
    /// (fetch → rebase → push) succeeds and the session completes with the
    /// correct GitSync* events emitted during finalize.
    #[tokio::test]
    async fn test_oneshot_branch_push_failure_retry_succeeds() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        // completing_after(1) gives 2 scenarios (design + implementation).
        // The mock reuses the last scenario when exhausted, so any extra
        // spawn_claude calls will also get a completing scenario.
        let mut runtime = MockRuntime::completing_after(1);

        // Command sequence:
        // 1. mkdir -p (worktree parent dir)                     -> success
        // 2. git worktree add -b {branch}                       -> success
        //    [design phase — spawn_claude #1]
        //    [implementation phase — spawn_claude #2]
        // --- git_merge_push begins ---
        // 3. git push origin {branch} (initial push)            -> FAIL
        // 4. git push -u origin {branch} (push_u fallback)      -> FAIL
        // --- retry loop attempt 1 ---
        // 5. git fetch origin {branch}                          -> success
        // 6. git pull --rebase origin {branch}                  -> success
        // 7. git push origin {branch} (after rebase)            -> success
        // --- git_merge_push ends ---
        // 8. git worktree remove                                -> success
        runtime.command_results = vec![
            // 1. mkdir -p
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git worktree add
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // 3. git push origin {branch} (initial) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: failed to push some refs".to_string(),
            },
            // 4. git push -u origin {branch} (push_u fallback) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 5. git fetch origin {branch} — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 6. git pull --rebase origin {branch} — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 7. git push origin {branch} (after rebase) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 8. git worktree remove — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result = runner.run(&runtime).await;
        assert!(
            result.is_ok(),
            "run should succeed after retry with rebase, got: {:?}",
            result.err()
        );

        let captured = events.lock().unwrap();

        // Verify GitFinalizeStarted is present with "branch" strategy
        let finalize_started_idx = captured
            .iter()
            .position(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. }))
            .expect("should have GitFinalizeStarted");
        match &captured[finalize_started_idx] {
            SessionEvent::GitFinalizeStarted { strategy } => {
                assert_eq!(strategy, "branch");
            }
            _ => panic!("expected GitFinalizeStarted"),
        }

        // All GitSync* events should appear AFTER GitFinalizeStarted
        let events_after_finalize = &captured[finalize_started_idx..];

        // Verify GitSyncPushSucceeded was emitted (the retry push succeeded)
        assert!(
            events_after_finalize
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. })),
            "should emit GitSyncPushSucceeded after successful retry push, got: {:?}",
            events_after_finalize
        );

        // Verify GitFinalizeComplete is present
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeComplete)),
            "should emit GitFinalizeComplete after successful push"
        );

        // Verify OneShotComplete is present
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should emit OneShotComplete after successful branch push with retry"
        );

        // Should NOT have OneShotFailed
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotFailed { .. })),
            "should not emit OneShotFailed on success"
        );
    }

    /// Test that when the Branch strategy's push fails and all retry attempts
    /// also fail, OneShotFailed is emitted with worktree preservation
    /// instructions and OneShotComplete is NOT emitted.
    #[tokio::test]
    async fn test_oneshot_branch_all_retries_fail() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, events) = setup_runner_with_events(&tmp, MergeStrategy::Branch);

        let mut runtime = MockRuntime::completing_after(1);

        // Command sequence:
        // 1. mkdir -p (worktree parent dir)                     -> success
        // 2. git worktree add -b {branch}                       -> success
        //    [design phase — spawn_claude #1]
        //    [implementation phase — spawn_claude #2]
        // --- git_merge_push begins ---
        // 3. git push origin {branch} (initial push)            -> FAIL
        // 4. git push -u origin {branch} (push_u fallback)      -> FAIL
        // --- retry loop attempt 1/3 ---
        // 5. git fetch origin {branch}                          -> success
        // 6. git pull --rebase origin {branch}                  -> success
        // 7. git push origin {branch}                           -> FAIL
        // --- retry loop attempt 2/3 ---
        // 8. git fetch origin {branch}                          -> success
        // 9. git pull --rebase origin {branch}                  -> success
        // 10. git push origin {branch}                          -> FAIL
        // --- retry loop attempt 3/3 ---
        // 11. git fetch origin {branch}                         -> success
        // 12. git pull --rebase origin {branch}                 -> success
        // 13. git push origin {branch}                          -> FAIL
        // --- git_merge_push returns Err (all retries exhausted) ---
        // NO git worktree remove should follow (worktree preserved)
        runtime.command_results = vec![
            // 1. mkdir -p
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git worktree add
            CommandOutput {
                exit_code: 0,
                stdout: "Preparing worktree".to_string(),
                stderr: String::new(),
            },
            // 3. git push origin {branch} (initial) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: failed to push some refs".to_string(),
            },
            // 4. git push -u origin {branch} (push_u fallback) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 5. git fetch (attempt 1) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 6. git rebase (attempt 1) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 7. git push (attempt 1) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
            // 8. git fetch (attempt 2) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 9. git rebase (attempt 2) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 10. git push (attempt 2) — FAIL
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
            // 11. git fetch (attempt 3) — success
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 12. git rebase (attempt 3) — success
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 13. git push (attempt 3) — FAIL (last retry)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: remote has changed".to_string(),
            },
            // If the implementation incorrectly tries to clean up after failure,
            // it would consume more commands from the mock. Since MockRuntime
            // repeats the last result when exhausted (exit_code: 1), any
            // additional cleanup commands would get a failure result. The test
            // verifies correctness through event assertions below.
        ];

        let _result = runner.run(&runtime).await;

        let captured = events.lock().unwrap();

        // Verify GitFinalizeStarted was emitted (we entered the finalize phase)
        assert!(
            captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeStarted { .. })),
            "should emit GitFinalizeStarted even when push eventually fails, events: {:?}",
            *captured
        );

        // Verify OneShotFailed is emitted with worktree preservation info
        let failed_event = captured
            .iter()
            .find(|e| matches!(e, SessionEvent::OneShotFailed { .. }));
        assert!(
            failed_event.is_some(),
            "should emit OneShotFailed when all retries are exhausted, events: {:?}",
            *captured
        );
        if let Some(SessionEvent::OneShotFailed { reason }) = failed_event {
            // The failure reason should mention push failure
            let reason_lower = reason.to_lowercase();
            assert!(
                reason_lower.contains("push")
                    || reason_lower.contains("retries")
                    || reason_lower.contains("failed"),
                "OneShotFailed reason should mention push failure, got: {}",
                reason
            );
            // The failure reason should mention the worktree path for preservation
            assert!(
                reason.contains("worktree"),
                "OneShotFailed reason should mention worktree preservation, got: {}",
                reason
            );
            // The failure reason should mention the branch name
            assert!(
                reason.contains("branch") || reason.contains("oneshot/"),
                "OneShotFailed reason should mention the branch, got: {}",
                reason
            );
        }

        // Verify OneShotComplete is NOT emitted
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::OneShotComplete)),
            "should not emit OneShotComplete when all retries fail"
        );

        // Verify GitFinalizeComplete is NOT emitted (finalize did not succeed)
        assert!(
            !captured
                .iter()
                .any(|e| matches!(e, SessionEvent::GitFinalizeComplete)),
            "should not emit GitFinalizeComplete when push fails after all retries"
        );
    }
}
