use anyhow::Result;
use chrono::Utc;
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
use tracing::instrument;

use crate::git_merge::{git_merge_push, GitMergeConfig, GitMergeEvent};
use crate::output::{ContentBlock, ResultEvent, StreamEvent};
use crate::runtime::{ClaudeInvocation, RuntimeProvider};
use crate::trace::{self, SessionOutcome, SpanAttributes, TraceCollector};

fn default_timeout() -> u32 { 1200 }
fn default_max_retries() -> u32 { 3 }

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckWhen {
    EachIteration,
    PostCompletion,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    pub command: String,
    pub when: CheckWhen,
    pub prompt: Option<String>,
    pub model: Option<String>,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u32,
    #[serde(default = "default_max_retries")]
    pub max_retries: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GitSyncConfig {
    pub enabled: bool,
    pub conflict_prompt: Option<String>,
    pub model: Option<String>,
    pub max_push_retries: u32,
}

impl Default for GitSyncConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            conflict_prompt: None,
            model: None,
            max_push_retries: 3,
        }
    }
}

/// Configuration for a Ralph loop session
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub repo_path: PathBuf,
    pub working_dir: Option<PathBuf>,
    pub prompt: String,
    pub max_iterations: u32,
    pub completion_signal: String,
    pub model: Option<String>,
    pub effort_level: Option<String>,
    pub extra_args: Vec<String>,
    /// Plan file path (if any)
    pub plan_file: Option<String>,
    /// Delay between iterations (rate limit protection)
    pub inter_iteration_delay_ms: u64,
    /// Extra environment variables to set when spawning Claude
    pub env_vars: std::collections::HashMap<String, String>,
    pub checks: Vec<Check>,
    pub git_sync: Option<GitSyncConfig>,
    /// Offset added to iteration numbers in emitted events (default 0).
    /// Used by 1-shot to avoid design/implementation phases colliding on iteration 1.
    pub iteration_offset: u32,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            repo_path: PathBuf::from("."),
            working_dir: None,
            prompt: String::new(),
            max_iterations: 20,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: Vec::new(),
            plan_file: None,
            inter_iteration_delay_ms: 1000,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        }
    }
}

impl SessionConfig {
    /// Returns the effective working directory: `working_dir` if set, otherwise `repo_path`.
    pub(crate) fn effective_working_dir(&self) -> &std::path::Path {
        self.working_dir.as_deref().unwrap_or(&self.repo_path)
    }
}

/// Represents the current state of a Ralph loop
#[derive(Debug, Clone, PartialEq)]
pub enum SessionState {
    Idle,
    Running { iteration: u32 },
    Evaluating { iteration: u32 },
    Completed { iterations: u32 },
    MaxIterations { iterations: u32 },
    Failed { iteration: u32, error: String },
    Cancelled { iteration: u32 },
    Disconnected { iteration: u32, reason: Option<String> },
    Reconnecting { iteration: u32 },
}

/// Events emitted during a session for UI consumption
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    /// Session has started
    SessionStarted { session_id: String },
    /// A new iteration is beginning
    IterationStarted { iteration: u32 },
    /// Claude is using a tool
    ToolUse {
        iteration: u32,
        tool_name: String,
        tool_input: Option<serde_json::Value>,
    },
    /// Claude produced text output
    AssistantText { iteration: u32, text: String },
    /// An iteration completed with its result
    IterationComplete { iteration: u32, result: ResultEvent },
    /// An iteration failed with an error (process crash, etc.)
    IterationFailed { iteration: u32, error: String },
    /// The entire session finished
    SessionComplete { outcome: SessionOutcome, plan_file: Option<String> },
    /// SSH connection lost, session may still be running remotely
    Disconnected { iteration: u32, reason: Option<String> },
    /// Attempting to reconnect to remote session
    Reconnecting { iteration: u32 },
    /// A post-loop check has started
    CheckStarted { iteration: u32, check_name: String },
    /// A post-loop check passed
    CheckPassed { iteration: u32, check_name: String },
    /// A post-loop check failed
    CheckFailed { iteration: u32, check_name: String, output: String },
    /// A fix agent has been spawned for a failed check
    CheckFixStarted { iteration: u32, check_name: String, attempt: u32 },
    /// A fix agent has completed
    CheckFixComplete { iteration: u32, check_name: String, attempt: u32, success: bool },
    /// 1-shot session has started
    OneShotStarted { title: String, parent_repo_id: String, prompt: String, merge_strategy: String, worktree_path: String, branch: String },
    /// Design phase has begun
    DesignPhaseStarted,
    /// Design phase completed, plan file written
    DesignPhaseComplete { plan_file: String },
    /// Implementation phase has begun
    ImplementationPhaseStarted,
    /// Implementation phase completed
    ImplementationPhaseComplete,
    /// Git finalize started (merge or push)
    GitFinalizeStarted { strategy: String },
    /// Git finalize completed
    GitFinalizeComplete,
    /// 1-shot completed successfully
    OneShotComplete,
    /// 1-shot failed
    OneShotFailed { reason: String },
    /// Git sync has started
    GitSyncStarted { iteration: u32 },
    /// Git push succeeded
    GitSyncPushSucceeded { iteration: u32 },
    /// Merge conflicts detected during rebase
    GitSyncConflict { iteration: u32, files: Vec<String> },
    /// Conflict resolution Claude spawn started
    GitSyncConflictResolveStarted { iteration: u32, attempt: u32 },
    /// Conflict resolution completed
    GitSyncConflictResolveComplete { iteration: u32, attempt: u32, success: bool },
    /// Git sync failed after all retries
    GitSyncFailed { iteration: u32, error: String },
    /// Claude API rate limit hit (non-"allowed" status only)
    RateLimited { iteration: u32, status: String, rate_limit_type: String },
}

/// Callback for receiving session events (Tauri IPC hookpoint)
pub type OnSessionEvent = Box<dyn Fn(&SessionEvent) + Send + Sync>;

fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, _) => stderr.to_string(),
        (_, true) => stdout.to_string(),
        _ => format!("{}\n{}", stdout, stderr),
    }
}

fn build_fix_prompt(check: &Check, output: &str) -> String {
    match &check.prompt {
        None => {
            format!(
                "The following check failed after a loop iteration.\n\n\
                 **Check:** {name}\n\
                 **Command:** {command}\n\n\
                 **Output:**\n\
                 ```\n\
                 {output}\n\
                 ```\n\n\
                 Fix the issues shown above. After fixing, run `{command}` to verify your fixes pass. \
                 Commit any changes with an appropriate message.",
                name = check.name,
                command = check.command,
                output = output,
            )
        }
        Some(custom) => {
            format!(
                "{custom}\n\n\
                 **Check output:**\n\
                 ```\n\
                 {output}\n\
                 ```",
                custom = custom,
                output = output,
            )
        }
    }
}

/// Shared registry of abort handles for active child processes.
/// Used to kill processes on app exit.
pub type AbortRegistry = std::sync::Arc<std::sync::Mutex<Vec<std::sync::Arc<dyn crate::runtime::AbortHandle>>>>;

/// Runs a Ralph loop session end-to-end
pub struct SessionRunner {
    config: SessionConfig,
    collector: TraceCollector,
    on_event: Option<OnSessionEvent>,
    cancel_token: CancellationToken,
    accumulated_events: std::sync::Mutex<Vec<SessionEvent>>,
    abort_registry: Option<AbortRegistry>,
    session_id: std::sync::Mutex<Option<String>>,
}

impl SessionRunner {
    pub fn new(config: SessionConfig, collector: TraceCollector, cancel_token: CancellationToken) -> Self {
        Self {
            config,
            collector,
            on_event: None,
            cancel_token,
            accumulated_events: std::sync::Mutex::new(Vec::new()),
            abort_registry: None,
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

    fn unregister_abort(&self, handle: &std::sync::Arc<dyn crate::runtime::AbortHandle>) {
        if let Some(ref registry) = self.abort_registry {
            let mut handles = registry.lock().unwrap();
            handles.retain(|h| !std::sync::Arc::ptr_eq(h, handle));
        }
    }

    fn emit(&self, event: SessionEvent) {
        let session_id = self.session_id.lock().unwrap().clone();
        let event_kind = match &event {
            SessionEvent::SessionStarted { .. } => "session_started",
            SessionEvent::IterationStarted { .. } => "iteration_started",
            SessionEvent::ToolUse { .. } => "tool_use",
            SessionEvent::AssistantText { .. } => "assistant_text",
            SessionEvent::IterationComplete { .. } => "iteration_complete",
            SessionEvent::IterationFailed { .. } => "iteration_failed",
            SessionEvent::SessionComplete { .. } => "session_complete",
            SessionEvent::Disconnected { .. } => "disconnected",
            SessionEvent::Reconnecting { .. } => "reconnecting",
            SessionEvent::CheckStarted { .. } => "check_started",
            SessionEvent::CheckPassed { .. } => "check_passed",
            SessionEvent::CheckFailed { .. } => "check_failed",
            SessionEvent::CheckFixStarted { .. } => "check_fix_started",
            SessionEvent::CheckFixComplete { .. } => "check_fix_complete",
            SessionEvent::OneShotStarted { .. } => "oneshot_started",
            SessionEvent::DesignPhaseStarted => "design_phase_started",
            SessionEvent::DesignPhaseComplete { .. } => "design_phase_complete",
            SessionEvent::ImplementationPhaseStarted => "implementation_phase_started",
            SessionEvent::ImplementationPhaseComplete => "implementation_phase_complete",
            SessionEvent::GitFinalizeStarted { .. } => "git_finalize_started",
            SessionEvent::GitFinalizeComplete => "git_finalize_complete",
            SessionEvent::OneShotComplete => "oneshot_complete",
            SessionEvent::OneShotFailed { .. } => "oneshot_failed",
            SessionEvent::GitSyncStarted { .. } => "git_sync_started",
            SessionEvent::GitSyncPushSucceeded { .. } => "git_sync_push_succeeded",
            SessionEvent::GitSyncConflict { .. } => "git_sync_conflict",
            SessionEvent::GitSyncConflictResolveStarted { .. } => "git_sync_conflict_resolve_started",
            SessionEvent::GitSyncConflictResolveComplete { .. } => "git_sync_conflict_resolve_complete",
            SessionEvent::GitSyncFailed { .. } => "git_sync_failed",
            SessionEvent::RateLimited { .. } => "rate_limited",
        };
        tracing::debug!(
            session_id = session_id.as_deref().unwrap_or("<none>"),
            event_kind,
            "emitting session event"
        );
        self.accumulated_events.lock().unwrap().push(event.clone());
        if let Some(ref sid) = session_id {
            if let Err(e) = self.collector.append_event(sid, &event) {
                tracing::warn!("Failed to append event to disk: {e}");
            }
        }
        if let Some(ref cb) = self.on_event {
            cb(&event);
        }
    }

    fn build_invocation(&self) -> ClaudeInvocation {
        ClaudeInvocation {
            prompt: self.config.prompt.clone(),
            working_dir: self.config.effective_working_dir().to_path_buf(),
            model: self.config.model.clone(),
            effort_level: self.config.effort_level.clone(),
            extra_args: self.config.extra_args.clone(),
            env_vars: self.config.env_vars.clone(),
        }
    }

    #[instrument(skip(self, runtime, checks), fields(iteration))]
    async fn run_checks(
        &self,
        runtime: &dyn RuntimeProvider,
        iteration: u32,
        when: &CheckWhen,
        checks: &[Check],
    ) {
        let matching: Vec<&Check> = checks.iter().filter(|c| &c.when == when).collect();

        tracing::info!(iteration, when = ?when, count = matching.len(), "checks starting");

        for check in matching {
            if self.cancel_token.is_cancelled() {
                return;
            }
            let check_name = check.name.clone();

            self.emit(SessionEvent::CheckStarted {
                iteration,
                check_name: check_name.clone(),
            });

            let cmd_result = runtime
                .run_command(
                    &check.command,
                    self.config.effective_working_dir(),
                    Duration::from_secs(check.timeout_secs as u64),
                )
                .await;

            let cmd_output = match cmd_result {
                Ok(o) => o,
                Err(e) => {
                    let error_msg = format!("Command error: {}", e);
                    tracing::warn!("Check '{}' command error: {}", check_name, e);
                    self.emit(SessionEvent::CheckFailed {
                        iteration,
                        check_name: check_name.clone(),
                        output: error_msg,
                    });
                    continue;
                }
            };

            if cmd_output.exit_code == 0 {
                tracing::info!(iteration, check_name = %check_name, "check passed");
                self.emit(SessionEvent::CheckPassed {
                    iteration,
                    check_name: check_name.clone(),
                });
                continue;
            }

            // Check failed
            let mut output = combine_output(&cmd_output.stdout, &cmd_output.stderr);

            self.emit(SessionEvent::CheckFailed {
                iteration,
                check_name: check_name.clone(),
                output: output.clone(),
            });

            let mut fixed = false;
            for attempt in 1..=check.max_retries {
                if self.cancel_token.is_cancelled() {
                    break;
                }
                let fix_prompt = build_fix_prompt(check, &output);

                self.emit(SessionEvent::CheckFixStarted {
                    iteration,
                    check_name: check_name.clone(),
                    attempt,
                });

                let fix_invocation = ClaudeInvocation {
                    prompt: fix_prompt,
                    working_dir: self.config.effective_working_dir().to_path_buf(),
                    model: check.model.clone().or_else(|| self.config.model.clone()),
                    effort_level: self.config.effort_level.clone(),
                    extra_args: vec!["--dangerously-skip-permissions".to_string()],
                    env_vars: self.config.env_vars.clone(),
                };

                match runtime.spawn_claude(&fix_invocation).await {
                    Ok(mut process) => {
                        // Drain events channel
                        while process.events.recv().await.is_some() {}
                        // Wait for completion
                        let _ = process.completion.await;

                        tracing::info!(iteration, check_name = %check_name, attempt, "fix agent succeeded");
                        self.emit(SessionEvent::CheckFixComplete {
                            iteration,
                            check_name: check_name.clone(),
                            attempt,
                            success: true,
                        });
                    }
                    Err(e) => {
                        tracing::warn!("Fix agent for '{}' failed to spawn: {}", check_name, e);
                        self.emit(SessionEvent::CheckFixComplete {
                            iteration,
                            check_name: check_name.clone(),
                            attempt,
                            success: false,
                        });
                        continue;
                    }
                }

                // Re-run the check
                let recheck = runtime
                    .run_command(
                        &check.command,
                        self.config.effective_working_dir(),
                        Duration::from_secs(check.timeout_secs as u64),
                    )
                    .await;

                match recheck {
                    Ok(recheck_output) => {
                        if recheck_output.exit_code == 0 {
                            tracing::info!(iteration, check_name = %check_name, attempt, "check now passing after fix");
                            self.emit(SessionEvent::CheckPassed {
                                iteration,
                                check_name: check_name.clone(),
                            });
                            fixed = true;
                            break;
                        } else {
                            output = combine_output(&recheck_output.stdout, &recheck_output.stderr);
                            self.emit(SessionEvent::CheckFailed {
                                iteration,
                                check_name: check_name.clone(),
                                output: output.clone(),
                            });
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Re-check '{}' command error: {}", check_name, e);
                        // Just log and continue retry loop — the re-check failed to execute
                    }
                }
            }

            if !fixed {
                tracing::warn!(
                    "Check '{}' still failing after {} retries, continuing",
                    check_name,
                    check.max_retries
                );
            }
        }
    }

    fn is_valid_branch_name(name: &str) -> bool {
        !name.is_empty()
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '/' || c == '-')
    }

    #[instrument(skip(self, runtime), fields(iteration))]
    async fn git_sync(&self, runtime: &dyn RuntimeProvider, iteration: u32) {
        tracing::info!(iteration, "git_sync entered");

        let git_sync_config = match &self.config.git_sync {
            Some(cfg) => cfg,
            None => return,
        };

        if !git_sync_config.enabled {
            return;
        }

        if self.cancel_token.is_cancelled() {
            return;
        }

        self.emit(SessionEvent::GitSyncStarted { iteration });

        let timeout = Duration::from_secs(120);

        // Step 1: Detect current branch
        let branch = match runtime
            .run_command("git branch --show-current", self.config.effective_working_dir(), timeout)
            .await
        {
            Ok(output) if output.exit_code == 0 => {
                let b = output.stdout.trim().to_string();
                tracing::debug!(iteration, branch = %b, "detected current branch");
                b
            }
            Ok(output) => {
                let error = combine_output(&output.stdout, &output.stderr);
                self.emit(SessionEvent::GitSyncFailed {
                    iteration,
                    error: format!("failed to detect branch: {}", error),
                });
                return;
            }
            Err(e) => {
                self.emit(SessionEvent::GitSyncFailed {
                    iteration,
                    error: format!("failed to detect branch: {}", e),
                });
                return;
            }
        };

        if !Self::is_valid_branch_name(&branch) {
            self.emit(SessionEvent::GitSyncFailed {
                iteration,
                error: "Invalid branch name".to_string(),
            });
            return;
        }

        // Build command strings for GitMergeConfig
        let push_cmd = format!("git push origin {branch}");
        let fetch_cmd = format!("git fetch origin {branch}");
        let rebase_cmd = format!("git pull --rebase origin {branch}");
        let push_u_cmd = format!("git push -u origin {branch}");

        let merge_config = GitMergeConfig {
            working_dir: self.config.effective_working_dir(),
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

        let _ = git_merge_push(runtime, &merge_config, |event| {
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
        })
        .await;
    }

    /// Execute the Ralph loop. Returns the finalized trace.
    #[instrument(skip(self, runtime), fields(repo_path = %self.config.effective_working_dir().display(), max_iterations = self.config.max_iterations))]
    pub async fn run(
        &self,
        runtime: &dyn RuntimeProvider,
    ) -> Result<trace::SessionTrace> {
        tracing::info!(runtime = runtime.name(), "running health check");
        runtime.health_check().await?;
        tracing::info!("health check passed");

        let repo_str = self.config.effective_working_dir().to_string_lossy().to_string();
        let mut trace = match self.session_id.lock().unwrap().as_ref() {
            Some(sid) => self.collector.start_session_with_id(sid, &repo_str, &self.config.prompt, self.config.plan_file.as_deref()),
            None => self.collector.start_session(&repo_str, &self.config.prompt, self.config.plan_file.as_deref()),
        };

        // Snapshot plan content if plan_file is configured
        if let Some(ref plan_path) = self.config.plan_file {
            match tokio::fs::read_to_string(plan_path).await {
                Ok(content) => {
                    tracing::info!(plan_file = %plan_path, "plan content snapshot captured");
                    trace.plan_content = Some(content);
                }
                Err(e) => {
                    tracing::warn!(plan_file = %plan_path, error = %e, "failed to read plan file, continuing without plan content");
                }
            }
        }

        tracing::info!(repo = %repo_str, max_iterations = self.config.max_iterations, "starting Ralph loop");
        tracing::info!(runtime = runtime.name(), "runtime selected");
        tracing::info!(signal = %self.config.completion_signal, "completion signal");
        if let Some(ref model) = self.config.model {
            tracing::info!(model = %model, "model override");
        }

        *self.session_id.lock().unwrap() = Some(trace.session_id.clone());

        self.emit(SessionEvent::SessionStarted {
            session_id: trace.session_id.clone(),
        });

        self.run_with_trace(runtime, &mut trace).await?;

        let outcome = trace.outcome.clone();
        let plan_file = trace.plan_file.clone();
        tracing::info!(outcome = ?outcome, plan_file = ?plan_file, "session complete, emitting SessionComplete");
        self.emit(SessionEvent::SessionComplete { outcome, plan_file });

        let events: Vec<SessionEvent> = {
            let guard = self.accumulated_events.lock().unwrap();
            guard.clone()
        };
        let trace_path = self.collector.finalize(&mut trace, &events).await?;
        tracing::info!(path = %trace_path.display(), "trace saved");

        trace::print_trace_summary(&trace);

        Ok(trace)
    }

    /// Execute the iteration loop, recording results to a caller-provided trace.
    ///
    /// Unlike [`run()`], this method does **not**:
    /// - call `self.collector.start_session()` (caller provides the trace)
    /// - call `self.collector.finalize()` (caller handles persistence)
    /// - emit `SessionStarted` or `SessionComplete` events
    ///
    /// It **does** run checks, git_sync, record iterations, emit iteration-level
    /// events, and set `trace.outcome` / `trace.failure_reason`.
    #[instrument(skip(self, runtime, trace), fields(max_iterations = self.config.max_iterations))]
    pub async fn run_with_trace(
        &self,
        runtime: &dyn RuntimeProvider,
        trace: &mut trace::SessionTrace,
    ) -> Result<()> {
        let mut state = SessionState::Idle;
        let invocation = self.build_invocation();
        let offset = self.config.iteration_offset;

        for iteration in 1..=self.config.max_iterations {
            let display_iter = iteration + offset;

            // Check cancellation before starting iteration
            if self.cancel_token.is_cancelled() {
                tracing::info!(iteration = display_iter, "session cancelled before iteration");
                state = SessionState::Cancelled { iteration };
                break;
            }

            let _ = SessionState::Running { iteration };
            tracing::info!(iteration = display_iter, max = self.config.max_iterations + offset, "starting iteration");

            self.emit(SessionEvent::IterationStarted { iteration: display_iter });

            let iter_start = Utc::now();

            match self.run_iteration(runtime, &invocation, display_iter).await {
                Ok((result, last_context_tokens)) => {
                    let iter_end = Utc::now();
                    let has_signal =
                        result.has_completion_signal(&self.config.completion_signal);
                    let is_error = result.is_error;
                    let result_text = result.result_text();

                    self.collector.record_iteration(
                        trace,
                        iter_start,
                        iter_end,
                        SpanAttributes {
                            iteration: display_iter,
                            claude_session_id: result.session_id.clone(),
                            cost_usd: result.total_cost_usd.unwrap_or(0.0),
                            num_turns: result.num_turns,
                            api_duration_ms: result.duration_api_ms,
                            completion_signal_found: has_signal,
                            exit_code: 0,
                            result_preview: result_text[..result_text.len().min(500)].to_string(),
                            token_usage: result.token_usage(),
                            model_token_usage: result.model_token_usage(),
                            final_context_tokens: last_context_tokens,
                        },
                        is_error,
                    );

                    self.emit(SessionEvent::IterationComplete {
                        iteration: display_iter,
                        result: result.clone(),
                    });

                    tracing::info!(iteration = display_iter, cost = result.total_cost_usd.unwrap_or(0.0), turns = result.num_turns.unwrap_or(0), signal = has_signal, "iteration complete");

                    state = SessionState::Evaluating { iteration };

                    self.run_checks(runtime, display_iter, &CheckWhen::EachIteration, &self.config.checks).await;
                    self.git_sync(runtime, display_iter).await;

                    if self.cancel_token.is_cancelled() {
                        tracing::info!(iteration = display_iter, "session cancelled after checks");
                        state = SessionState::Cancelled { iteration };
                        break;
                    }

                    if has_signal {
                        tracing::info!("completion signal detected, stopping loop");
                        self.run_checks(runtime, display_iter, &CheckWhen::PostCompletion, &self.config.checks).await;
                        self.git_sync(runtime, display_iter).await;
                        state = SessionState::Completed {
                            iterations: iteration,
                        };
                        break;
                    }

                    if is_error {
                        tracing::error!(iteration = display_iter, "error detected in iteration");
                        state = SessionState::Failed {
                            iteration,
                            error: result_text,
                        };
                        break;
                    }

                    // Inter-iteration delay, but cancel-aware
                    if iteration < self.config.max_iterations {
                        tokio::select! {
                            _ = tokio::time::sleep(tokio::time::Duration::from_millis(
                                self.config.inter_iteration_delay_ms,
                            )) => {}
                            _ = self.cancel_token.cancelled() => {
                                tracing::info!("session cancelled during inter-iteration delay");
                                state = SessionState::Cancelled { iteration };
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    // Check if this was a cancellation-induced error
                    if self.cancel_token.is_cancelled() {
                        tracing::info!(iteration = display_iter, "session cancelled during iteration");
                        state = SessionState::Cancelled { iteration };
                        break;
                    }

                    let iter_end = Utc::now();
                    tracing::error!(iteration = display_iter, error = %e, "process error in iteration");

                    self.collector.record_iteration(
                        trace,
                        iter_start,
                        iter_end,
                        SpanAttributes {
                            iteration: display_iter,
                            claude_session_id: None,
                            cost_usd: 0.0,
                            num_turns: None,
                            api_duration_ms: None,
                            completion_signal_found: false,
                            exit_code: -1,
                            result_preview: format!("Process error: {e}"),
                            token_usage: Default::default(),
                            model_token_usage: Default::default(),
                            final_context_tokens: 0,
                        },
                        true,
                    );

                    self.emit(SessionEvent::IterationFailed {
                        iteration: display_iter,
                        error: e.to_string(),
                    });

                    state = SessionState::Failed {
                        iteration,
                        error: e.to_string(),
                    };
                    break;
                }
            }
        }

        if matches!(state, SessionState::Evaluating { .. }) {
            state = SessionState::MaxIterations {
                iterations: self.config.max_iterations,
            };
            tracing::warn!(max_iterations = self.config.max_iterations, "max iterations reached without completion signal");
        }

        // Session-exit git_sync: push partial progress for non-completed outcomes
        match &state {
            SessionState::Failed { iteration, .. } => {
                self.git_sync(runtime, *iteration).await;
            }
            SessionState::MaxIterations { iterations } => {
                self.git_sync(runtime, *iterations).await;
            }
            SessionState::Cancelled { iteration } => {
                self.git_sync(runtime, *iteration).await;
            }
            _ => {}
        }

        trace.outcome = match &state {
            SessionState::Completed { .. } => SessionOutcome::Completed,
            SessionState::MaxIterations { .. } => SessionOutcome::MaxIterationsReached,
            SessionState::Failed { .. } => SessionOutcome::Failed,
            SessionState::Cancelled { .. } => SessionOutcome::Cancelled,
            _ => SessionOutcome::Running,
        };

        trace.failure_reason = match &state {
            SessionState::Failed { error, .. } => Some(error.clone()),
            _ => None,
        };

        tracing::info!(outcome = ?trace.outcome, failure_reason = ?trace.failure_reason, "session loop finished");

        Ok(())
    }

    /// Run a single iteration: spawn Claude, consume streaming events, return the final result.
    #[instrument(skip(self, runtime, invocation), fields(iteration, working_dir = %invocation.working_dir.display()))]
    async fn run_iteration(
        &self,
        runtime: &dyn RuntimeProvider,
        invocation: &ClaudeInvocation,
        iteration: u32,
    ) -> Result<(ResultEvent, u64)> {
        tracing::info!(iteration, working_dir = %invocation.working_dir.display(), "spawning claude process");
        let mut process = runtime.spawn_claude(invocation).await?;
        tracing::info!(iteration, "claude process spawned");
        let mut result_event: Option<ResultEvent> = None;
        let mut last_context_tokens: u64 = 0;
        let mut last_assistant_text = String::new();
        let mut event_count: u32 = 0;
        let mut event_summary = Vec::<String>::new();

        // Register abort handle so it can be called on app exit
        let abort_arc: std::sync::Arc<dyn crate::runtime::AbortHandle> = std::sync::Arc::from(process.abort_handle);
        if let Some(ref registry) = self.abort_registry {
            registry.lock().unwrap().push(abort_arc.clone());
        }

        // Consume streaming events, but bail if cancellation is requested
        loop {
            tokio::select! {
                event = process.events.recv() => {
                    let Some(event) = event else { break };
                    event_count += 1;
                    match &event {
                        StreamEvent::System(sys) => {
                            if let Some(ref subtype) = sys.subtype {
                                event_summary.push(format!("system:{subtype}"));
                            } else {
                                event_summary.push("system:init".to_string());
                            }
                            if let Some(ref model) = sys.model {
                                tracing::debug!("Iteration {iteration}: model={model}");
                            }
                        }
                        StreamEvent::Assistant(assistant) => {
                            for block in &assistant.message.content {
                                match block {
                                    ContentBlock::ToolUse { name, input, .. } => {
                                        tracing::debug!(iteration, name, "tool use");
                                        self.emit(SessionEvent::ToolUse {
                                            iteration,
                                            tool_name: name.clone(),
                                            tool_input: Some(input.clone()),
                                        });
                                    }
                                    ContentBlock::Text { text } => {
                                        let preview = if text.chars().count() > 100 {
                                            let truncated: String = text.chars().take(100).collect();
                                            format!("{truncated}...")
                                        } else {
                                            text.clone()
                                        };
                                        tracing::debug!(iteration, preview, "text output");
                                        last_assistant_text = text.clone();
                                        self.emit(SessionEvent::AssistantText {
                                            iteration,
                                            text: text.clone(),
                                        });
                                    }
                                    ContentBlock::Unknown => {}
                                }
                            }
                            if let Some(ref usage) = assistant.message.usage {
                                last_context_tokens =
                                    usage.input_tokens.unwrap_or(0)
                                    + usage.cache_read_input_tokens.unwrap_or(0)
                                    + usage.cache_creation_input_tokens.unwrap_or(0);
                            }
                        }
                        StreamEvent::RateLimit(rl) => {
                            if let Some(ref info) = rl.rate_limit_info {
                                let status = info.status.as_deref().unwrap_or("unknown");
                                let rl_type = info.rate_limit_type.as_deref().unwrap_or("unknown");
                                // Only surface non-"allowed" rate limits — "allowed" fires every turn
                                if status != "allowed" {
                                    event_summary.push(format!("rate_limit:{status}/{rl_type}"));
                                    self.emit(SessionEvent::RateLimited {
                                        iteration,
                                        status: status.to_string(),
                                        rate_limit_type: rl_type.to_string(),
                                    });
                                }
                                tracing::debug!(
                                    "Rate limit: status={:?} type={:?}",
                                    info.status,
                                    info.rate_limit_type
                                );
                            }
                        }
                        StreamEvent::Result(r) => {
                            result_event = Some(r.clone());
                        }
                        StreamEvent::User(_) => {
                            // Tool results flowing back — not interesting for display
                        }
                    }
                }
                _ = self.cancel_token.cancelled() => {
                    // Kill the child process
                    abort_arc.abort();
                    self.unregister_abort(&abort_arc);
                    anyhow::bail!("Session cancelled");
                }
            }
        }

        // Wait for process to exit
        let exit = process.completion.await??;
        self.unregister_abort(&abort_arc);
        tracing::info!(
            iteration,
            exit_code = exit.exit_code,
            wall_time_ms = exit.wall_time_ms,
            has_result = result_event.is_some(),
            "claude process exited"
        );

        if exit.exit_code != 0 && result_event.is_none() {
            let stderr = exit.stderr.trim();
            let output = combine_output(last_assistant_text.trim(), stderr);
            let events_desc = if event_summary.is_empty() {
                "no events received".to_string()
            } else {
                format!("{event_count} events: [{}]", event_summary.join(", "))
            };
            tracing::error!(iteration, exit_code = exit.exit_code, stderr = %stderr, last_output = %last_assistant_text.trim(), events = %events_desc, "claude process failed with no result");
            if output.is_empty() {
                anyhow::bail!(
                    "Claude process exited with code {} ({events_desc})",
                    exit.exit_code,
                );
            } else {
                anyhow::bail!(
                    "Claude process exited with code {} — {output}",
                    exit.exit_code,
                );
            }
        }

        if result_event.is_none() {
            tracing::error!(iteration, "claude process exited without emitting a result event");
        }

        result_event
            .ok_or_else(|| anyhow::anyhow!("Claude process exited without emitting a result event"))
            .map(|r| (r, last_context_tokens))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{CommandOutput, MockRuntime};
    use crate::trace::{SessionOutcome, TraceCollector};
    use tempfile::TempDir;

    #[tokio::test]
    async fn run_accumulates_events_to_disk() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(2); // 2 working iterations + completion
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0, // no delay for tests
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let trace = runner.run(&runtime).await.expect("run should succeed");

        // The trace should show completion
        assert_eq!(trace.outcome, SessionOutcome::Completed);
        // MockRuntime::completing_after(2) does 2 working iterations + 1 completion = 3 total
        assert_eq!(trace.total_iterations, 3);

        // Now read back the events file and verify it has actual events
        let events = TraceCollector::read_events(base_dir, "test-repo", &trace.session_id)
            .expect("should read events file");

        // Should NOT be empty — this is the whole point of Task 3
        assert!(!events.is_empty(), "events file should have accumulated events");

        // Should start with SessionStarted
        match &events[0] {
            SessionEvent::SessionStarted { .. } => {}
            other => panic!("expected SessionStarted as first event, got {:?}", other),
        }

        // Should end with SessionComplete
        match events.last().unwrap() {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
                assert_eq!(*plan_file, None, "plan_file should be None when not set in config");
            }
            other => panic!("expected SessionComplete as last event, got {:?}", other),
        }

        // Should have IterationStarted events (at least 3 — one per iteration)
        let iteration_started_count = events.iter().filter(|e| matches!(e, SessionEvent::IterationStarted { .. })).count();
        assert_eq!(iteration_started_count, 3, "should have 3 IterationStarted events");

        // Should have IterationComplete events (3 iterations)
        let iteration_complete_count = events.iter().filter(|e| matches!(e, SessionEvent::IterationComplete { .. })).count();
        assert_eq!(iteration_complete_count, 3, "should have 3 IterationComplete events");

        // Should have ToolUse events (each mock iteration emits 2 tool uses)
        let tool_use_count = events.iter().filter(|e| matches!(e, SessionEvent::ToolUse { .. })).count();
        assert!(tool_use_count >= 6, "should have at least 6 ToolUse events (2 per iteration × 3 iterations), got {}", tool_use_count);

        // Should have AssistantText events (1 per iteration)
        let text_count = events.iter().filter(|e| matches!(e, SessionEvent::AssistantText { .. })).count();
        assert_eq!(text_count, 3, "should have 3 AssistantText events (1 per iteration)");
    }

    #[test]
    fn check_serializes_correctly() {
        let check = Check {
            name: "lint".to_string(),
            command: "npm run lint".to_string(),
            when: CheckWhen::EachIteration,
            prompt: Some("Fix lint errors".to_string()),
            model: Some("claude-sonnet".to_string()),
            timeout_secs: 600,
            max_retries: 5,
        };

        let json = serde_json::to_value(&check).expect("serialize Check");
        assert_eq!(json["name"], "lint");
        assert_eq!(json["command"], "npm run lint");
        assert_eq!(json["when"], "each_iteration");
        assert_eq!(json["prompt"], "Fix lint errors");
        assert_eq!(json["model"], "claude-sonnet");
        assert_eq!(json["timeoutSecs"], 600);
        assert_eq!(json["maxRetries"], 5);
    }

    #[test]
    fn check_deserializes_from_json() {
        let json = serde_json::json!({
            "name": "test",
            "command": "cargo test",
            "when": "post_completion",
            "prompt": "Fix failing tests",
            "model": "claude-opus",
            "timeoutSecs": 300,
            "maxRetries": 2
        });

        let check: Check = serde_json::from_value(json).expect("deserialize Check");
        assert_eq!(check.name, "test");
        assert_eq!(check.command, "cargo test");
        assert!(matches!(check.when, CheckWhen::PostCompletion));
        assert_eq!(check.prompt, Some("Fix failing tests".to_string()));
        assert_eq!(check.model, Some("claude-opus".to_string()));
        assert_eq!(check.timeout_secs, 300);
        assert_eq!(check.max_retries, 2);
    }

    #[test]
    fn check_when_serializes_as_snake_case() {
        let each = serde_json::to_value(CheckWhen::EachIteration).expect("serialize EachIteration");
        assert_eq!(each, serde_json::json!("each_iteration"));

        let post = serde_json::to_value(CheckWhen::PostCompletion).expect("serialize PostCompletion");
        assert_eq!(post, serde_json::json!("post_completion"));
    }

    #[test]
    fn session_config_default_has_empty_checks() {
        let config = SessionConfig::default();
        assert!(config.checks.is_empty(), "default checks should be an empty vec");
    }

    // =========================================================================
    // Task 6: SessionEvent check variant serialization
    // =========================================================================

    #[test]
    fn check_started_event_serializes_correctly() {
        let event = SessionEvent::CheckStarted {
            iteration: 1,
            check_name: "lint".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize CheckStarted");
        assert_eq!(json["kind"], "check_started");
        assert_eq!(json["iteration"], 1);
        assert_eq!(json["check_name"], "lint");
    }

    #[test]
    fn check_passed_event_serializes_correctly() {
        let event = SessionEvent::CheckPassed {
            iteration: 2,
            check_name: "tests".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize CheckPassed");
        assert_eq!(json["kind"], "check_passed");
        assert_eq!(json["iteration"], 2);
        assert_eq!(json["check_name"], "tests");
    }

    #[test]
    fn check_failed_event_serializes_correctly() {
        let event = SessionEvent::CheckFailed {
            iteration: 3,
            check_name: "typecheck".to_string(),
            output: "error TS2345: Argument of type...".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize CheckFailed");
        assert_eq!(json["kind"], "check_failed");
        assert_eq!(json["iteration"], 3);
        assert_eq!(json["check_name"], "typecheck");
        assert_eq!(json["output"], "error TS2345: Argument of type...");
    }

    #[test]
    fn check_fix_started_event_serializes_correctly() {
        let event = SessionEvent::CheckFixStarted {
            iteration: 1,
            check_name: "lint".to_string(),
            attempt: 1,
        };
        let json = serde_json::to_value(&event).expect("serialize CheckFixStarted");
        assert_eq!(json["kind"], "check_fix_started");
        assert_eq!(json["iteration"], 1);
        assert_eq!(json["check_name"], "lint");
        assert_eq!(json["attempt"], 1);
    }

    #[test]
    fn check_fix_complete_event_serializes_correctly() {
        let event = SessionEvent::CheckFixComplete {
            iteration: 1,
            check_name: "lint".to_string(),
            attempt: 2,
            success: true,
        };
        let json = serde_json::to_value(&event).expect("serialize CheckFixComplete");
        assert_eq!(json["kind"], "check_fix_complete");
        assert_eq!(json["iteration"], 1);
        assert_eq!(json["check_name"], "lint");
        assert_eq!(json["attempt"], 2);
        assert_eq!(json["success"], true);
    }

    #[test]
    fn check_fix_complete_event_serializes_failure() {
        let event = SessionEvent::CheckFixComplete {
            iteration: 4,
            check_name: "tests".to_string(),
            attempt: 3,
            success: false,
        };
        let json = serde_json::to_value(&event).expect("serialize CheckFixComplete with failure");
        assert_eq!(json["kind"], "check_fix_complete");
        assert_eq!(json["iteration"], 4);
        assert_eq!(json["check_name"], "tests");
        assert_eq!(json["attempt"], 3);
        assert_eq!(json["success"], false);
    }

    #[test]
    fn all_check_event_variants_roundtrip_through_json() {
        let events = vec![
            SessionEvent::CheckStarted { iteration: 1, check_name: "lint".to_string() },
            SessionEvent::CheckPassed { iteration: 1, check_name: "lint".to_string() },
            SessionEvent::CheckFailed { iteration: 2, check_name: "test".to_string(), output: "FAIL".to_string() },
            SessionEvent::CheckFixStarted { iteration: 2, check_name: "test".to_string(), attempt: 1 },
            SessionEvent::CheckFixComplete { iteration: 2, check_name: "test".to_string(), attempt: 1, success: true },
        ];

        for event in &events {
            let json_str = serde_json::to_string(event).expect("serialize event");
            let deserialized: SessionEvent = serde_json::from_str(&json_str).expect("deserialize event");
            // Verify roundtrip by re-serializing and comparing JSON values
            let original_value = serde_json::to_value(event).expect("to_value original");
            let roundtrip_value = serde_json::to_value(&deserialized).expect("to_value roundtrip");
            assert_eq!(original_value, roundtrip_value, "roundtrip failed for {:?}", event);
        }
    }

    // =========================================================================
    // Task 7: build_fix_prompt helper
    // =========================================================================

    #[test]
    fn build_fix_prompt_default_contains_check_name_command_and_output() {
        let check = Check {
            name: "lint".to_string(),
            command: "npm run lint".to_string(),
            when: CheckWhen::EachIteration,
            prompt: None,
            model: None,
            timeout_secs: 60,
            max_retries: 3,
        };
        let output = "error: unused variable `x`\n  --> src/main.rs:5:9";

        let prompt = build_fix_prompt(&check, output);

        assert!(
            prompt.contains("lint"),
            "default fix prompt should contain the check name, got: {prompt}"
        );
        assert!(
            prompt.contains("npm run lint"),
            "default fix prompt should contain the command, got: {prompt}"
        );
        assert!(
            prompt.contains(output),
            "default fix prompt should contain the command output, got: {prompt}"
        );
    }

    #[test]
    fn build_fix_prompt_custom_uses_custom_text_and_output() {
        let check = Check {
            name: "typecheck".to_string(),
            command: "npx tsc --noEmit".to_string(),
            when: CheckWhen::EachIteration,
            prompt: Some("Please fix all TypeScript type errors.".to_string()),
            model: None,
            timeout_secs: 120,
            max_retries: 2,
        };
        let output = "error TS2345: Argument of type 'string' is not assignable";

        let prompt = build_fix_prompt(&check, output);

        assert!(
            prompt.contains("Please fix all TypeScript type errors."),
            "custom fix prompt should contain the custom prompt text, got: {prompt}"
        );
        assert!(
            prompt.contains(output),
            "custom fix prompt should contain the command output, got: {prompt}"
        );
    }

    #[test]
    fn build_fix_prompt_custom_prompt_empty_output() {
        let check = Check {
            name: "build".to_string(),
            command: "cargo build".to_string(),
            when: CheckWhen::PostCompletion,
            prompt: Some("Fix compilation errors".to_string()),
            model: None,
            timeout_secs: 300,
            max_retries: 1,
        };
        let output = "";

        let prompt = build_fix_prompt(&check, output);

        assert!(
            prompt.contains("Fix compilation errors"),
            "prompt should contain custom text even with empty output, got: {prompt}"
        );
    }

    // =========================================================================
    // Task 7: run_checks method
    // =========================================================================

    fn make_check(name: &str, command: &str, when: CheckWhen) -> Check {
        Check {
            name: name.to_string(),
            command: command.to_string(),
            when,
            prompt: None,
            model: None,
            timeout_secs: 60,
            max_retries: 3,
        }
    }

    fn make_runner(tmp: &TempDir, checks: Vec<Check>) -> SessionRunner {
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks,
            git_sync: None,
            iteration_offset: 0,
        };
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        SessionRunner::new(config, collector, cancel_token)
    }

    fn get_events(runner: &SessionRunner) -> Vec<SessionEvent> {
        runner.accumulated_events.lock().unwrap().clone()
    }

    #[tokio::test]
    async fn run_checks_passing_check_emits_started_and_passed() {
        let tmp = TempDir::new().expect("create temp dir");
        let check = make_check("lint", "npm run lint", CheckWhen::EachIteration);
        let runner = make_runner(&tmp, vec![check.clone()]);

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "All clear!".to_string(),
            stderr: String::new(),
        }];

        runner
            .run_checks(&runtime, 1, &CheckWhen::EachIteration, &[check])
            .await;

        let events = get_events(&runner);

        // Should have CheckStarted then CheckPassed
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { iteration: 1, ref check_name } if check_name == "lint")),
            "should emit CheckStarted for lint, events: {:?}", events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckPassed { iteration: 1, ref check_name } if check_name == "lint")),
            "should emit CheckPassed for lint, events: {:?}", events
        );
        // Should NOT have any failure or fix events
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::CheckFailed { .. })),
            "should not emit CheckFailed for passing check"
        );
    }

    #[tokio::test]
    async fn run_checks_failing_check_with_successful_retry() {
        let tmp = TempDir::new().expect("create temp dir");
        let check = make_check("test", "cargo test", CheckWhen::EachIteration);
        let runner = make_runner(&tmp, vec![check.clone()]);

        let mut runtime = MockRuntime::completing_after(1);
        // First call: check fails. Second call: re-run after fix succeeds.
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 1,
                stdout: "test result: FAILED. 1 passed; 2 failed".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "test result: ok. 3 passed; 0 failed".to_string(),
                stderr: String::new(),
            },
        ];

        runner
            .run_checks(&runtime, 1, &CheckWhen::EachIteration, &[check])
            .await;

        let events = get_events(&runner);

        // Should have the full lifecycle: started -> failed -> fix_started -> fix_complete -> passed
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { iteration: 1, ref check_name } if check_name == "test")),
            "should emit CheckStarted, events: {:?}", events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckFailed { iteration: 1, ref check_name, .. } if check_name == "test")),
            "should emit CheckFailed, events: {:?}", events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckFixStarted { iteration: 1, ref check_name, attempt: 1 } if check_name == "test")),
            "should emit CheckFixStarted with attempt=1, events: {:?}", events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckFixComplete { iteration: 1, ref check_name, attempt: 1, success: true } if check_name == "test")),
            "should emit CheckFixComplete with success=true, events: {:?}", events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckPassed { iteration: 1, ref check_name } if check_name == "test")),
            "should emit CheckPassed after successful fix, events: {:?}", events
        );
    }

    #[tokio::test]
    async fn run_checks_failing_check_exhausting_retries() {
        let tmp = TempDir::new().expect("create temp dir");
        let mut check = make_check("lint", "npm run lint", CheckWhen::EachIteration);
        check.max_retries = 2;
        let runner = make_runner(&tmp, vec![check.clone()]);

        let mut runtime = MockRuntime::completing_after(1);
        // All command runs fail (initial + re-runs after each fix attempt)
        runtime.command_results = vec![
            CommandOutput { exit_code: 1, stdout: "error 1".to_string(), stderr: String::new() },
            CommandOutput { exit_code: 1, stdout: "error 2".to_string(), stderr: String::new() },
            CommandOutput { exit_code: 1, stdout: "error 3".to_string(), stderr: String::new() },
        ];

        runner
            .run_checks(&runtime, 1, &CheckWhen::EachIteration, &[check])
            .await;

        let events = get_events(&runner);

        // Should have CheckStarted
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { .. })),
            "should emit CheckStarted, events: {:?}", events
        );

        // Should have CheckFailed (at least the initial failure)
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckFailed { .. })),
            "should emit CheckFailed, events: {:?}", events
        );

        // Should have fix attempts for each retry (max_retries = 2)
        let fix_started_count = events.iter().filter(|e| matches!(e, SessionEvent::CheckFixStarted { .. })).count();
        assert_eq!(
            fix_started_count, 2,
            "should have 2 CheckFixStarted events (max_retries=2), got {}", fix_started_count
        );

        let fix_complete_count = events.iter().filter(|e| matches!(e, SessionEvent::CheckFixComplete { .. })).count();
        assert_eq!(
            fix_complete_count, 2,
            "should have 2 CheckFixComplete events, got {}", fix_complete_count
        );

        // Should NOT have CheckPassed since all retries failed
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::CheckPassed { .. })),
            "should not emit CheckPassed when all retries are exhausted, events: {:?}", events
        );

        // Session should continue (no panic) — the test completing is proof of this
    }

    #[tokio::test]
    async fn run_checks_filters_by_check_when() {
        let tmp = TempDir::new().expect("create temp dir");
        let each_iter_check = make_check("lint", "npm run lint", CheckWhen::EachIteration);
        let post_completion_check = make_check("e2e", "npm run test:e2e", CheckWhen::PostCompletion);
        let checks = vec![each_iter_check.clone(), post_completion_check.clone()];
        let runner = make_runner(&tmp, checks.clone());

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "ok".to_string(),
            stderr: String::new(),
        }];

        // Run with EachIteration filter — only the lint check should run
        runner
            .run_checks(&runtime, 1, &CheckWhen::EachIteration, &checks)
            .await;

        let events = get_events(&runner);

        // Should have events for the EachIteration check ("lint")
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "lint")),
            "should run EachIteration check 'lint', events: {:?}", events
        );

        // Should NOT have events for the PostCompletion check ("e2e")
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "e2e")),
            "should not run PostCompletion check 'e2e' when filtering for EachIteration, events: {:?}", events
        );
    }

    #[tokio::test]
    async fn run_checks_post_completion_filter_runs_only_post_completion_checks() {
        let tmp = TempDir::new().expect("create temp dir");
        let each_iter_check = make_check("lint", "npm run lint", CheckWhen::EachIteration);
        let post_completion_check = make_check("e2e", "npm run test:e2e", CheckWhen::PostCompletion);
        let checks = vec![each_iter_check.clone(), post_completion_check.clone()];
        let runner = make_runner(&tmp, checks.clone());

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "ok".to_string(),
            stderr: String::new(),
        }];

        // Run with PostCompletion filter — only the e2e check should run
        runner
            .run_checks(&runtime, 1, &CheckWhen::PostCompletion, &checks)
            .await;

        let events = get_events(&runner);

        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "e2e")),
            "should run PostCompletion check 'e2e', events: {:?}", events
        );
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "lint")),
            "should not run EachIteration check 'lint' when filtering for PostCompletion, events: {:?}", events
        );
    }

    // =========================================================================
    // Task 8: Integration into session loop
    // =========================================================================

    #[tokio::test]
    async fn each_iteration_checks_run_after_each_iteration() {
        let tmp = TempDir::new().expect("create temp dir");
        let check = make_check("lint", "npm run lint", CheckWhen::EachIteration);

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        // 2 working iterations + 1 completion = 3 total iterations
        let mut runtime = MockRuntime::completing_after(2);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "All good".to_string(),
            stderr: String::new(),
        }];

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // For each iteration, check events should appear after IterationComplete
        // There should be 3 iterations, so at least 3 CheckStarted events
        let check_started_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "lint"))
            .count();
        assert!(
            check_started_count >= 3,
            "should have at least 3 CheckStarted events (one per iteration), got {}",
            check_started_count
        );

        // Verify ordering: each CheckStarted should come after its IterationComplete
        let mut last_iteration_complete_idx: Option<usize> = None;
        for (idx, event) in events.iter().enumerate() {
            if let SessionEvent::IterationComplete { iteration: _, .. } = event {
                last_iteration_complete_idx = Some(idx);
            }
            if let SessionEvent::CheckStarted { iteration, check_name } = event {
                if check_name == "lint" {
                    assert!(
                        last_iteration_complete_idx.is_some(),
                        "CheckStarted for iteration {} should come after an IterationComplete",
                        iteration
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn post_completion_checks_run_after_completion_before_session_complete() {
        let tmp = TempDir::new().expect("create temp dir");
        let check = make_check("e2e", "npm run test:e2e", CheckWhen::PostCompletion);

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        // Complete immediately after 1 iteration
        let mut runtime = MockRuntime::completing_after(0);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "All tests passed".to_string(),
            stderr: String::new(),
        }];

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // Should have a CheckStarted for the PostCompletion check
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "e2e")),
            "should run PostCompletion check 'e2e' after completion, events: {:?}", events
        );

        // Find positions of key events
        let check_started_idx = events
            .iter()
            .position(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "e2e"))
            .expect("should have CheckStarted for e2e");

        let session_complete_idx = events
            .iter()
            .position(|e| matches!(e, SessionEvent::SessionComplete { .. }))
            .expect("should have SessionComplete");

        // The last IterationComplete with the completion signal
        let last_iteration_complete_idx = events
            .iter()
            .rposition(|e| matches!(e, SessionEvent::IterationComplete { .. }))
            .expect("should have at least one IterationComplete");

        // PostCompletion check should run after the completion iteration but before SessionComplete
        assert!(
            check_started_idx > last_iteration_complete_idx,
            "CheckStarted (idx={}) should come after last IterationComplete (idx={})",
            check_started_idx,
            last_iteration_complete_idx
        );
        assert!(
            check_started_idx < session_complete_idx,
            "CheckStarted (idx={}) should come before SessionComplete (idx={})",
            check_started_idx,
            session_complete_idx
        );
    }

    #[tokio::test]
    async fn each_iteration_checks_do_not_run_post_completion_checks() {
        let tmp = TempDir::new().expect("create temp dir");
        // Only have a PostCompletion check, no EachIteration checks
        let check = make_check("e2e", "npm run test:e2e", CheckWhen::PostCompletion);

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        // 2 working iterations + 1 completion = 3 iterations
        let mut runtime = MockRuntime::completing_after(2);
        runtime.command_results = vec![CommandOutput {
            exit_code: 0,
            stdout: "ok".to_string(),
            stderr: String::new(),
        }];

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // The PostCompletion check should only appear once (after completion), not after each iteration
        let check_started_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::CheckStarted { ref check_name, .. } if check_name == "e2e"))
            .count();
        assert_eq!(
            check_started_count, 1,
            "PostCompletion check should run exactly once (after completion), got {}",
            check_started_count
        );
    }

    // =========================================================================
    // 1-shot: SessionEvent oneshot variant serialization
    // =========================================================================

    #[test]
    fn oneshot_event_variants_serialize_correctly() {
        // 1. OneShotStarted
        let event = SessionEvent::OneShotStarted {
            title: "Implement auth module".to_string(),
            parent_repo_id: "test-repo".to_string(),
            prompt: "Implement auth".to_string(),
            merge_strategy: "squash".to_string(),
            worktree_path: "/tmp/worktrees/test".to_string(),
            branch: "yarr/implement-auth-module-abc123".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize OneShotStarted");
        assert_eq!(json["kind"], "one_shot_started");
        assert_eq!(json["title"], "Implement auth module");
        assert_eq!(json["parent_repo_id"], "test-repo");
        assert_eq!(json["prompt"], "Implement auth");
        assert_eq!(json["merge_strategy"], "squash");
        assert_eq!(json["worktree_path"], "/tmp/worktrees/test");
        assert_eq!(json["branch"], "yarr/implement-auth-module-abc123");

        // 2. DesignPhaseStarted
        let event = SessionEvent::DesignPhaseStarted;
        let json = serde_json::to_value(&event).expect("serialize DesignPhaseStarted");
        assert_eq!(json["kind"], "design_phase_started");

        // 3. DesignPhaseComplete
        let event = SessionEvent::DesignPhaseComplete {
            plan_file: "/tmp/plan.md".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize DesignPhaseComplete");
        assert_eq!(json["kind"], "design_phase_complete");
        assert_eq!(json["plan_file"], "/tmp/plan.md");

        // 4. ImplementationPhaseStarted
        let event = SessionEvent::ImplementationPhaseStarted;
        let json = serde_json::to_value(&event).expect("serialize ImplementationPhaseStarted");
        assert_eq!(json["kind"], "implementation_phase_started");

        // 5. ImplementationPhaseComplete
        let event = SessionEvent::ImplementationPhaseComplete;
        let json = serde_json::to_value(&event).expect("serialize ImplementationPhaseComplete");
        assert_eq!(json["kind"], "implementation_phase_complete");

        // 6. GitFinalizeStarted
        let event = SessionEvent::GitFinalizeStarted {
            strategy: "squash".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize GitFinalizeStarted");
        assert_eq!(json["kind"], "git_finalize_started");
        assert_eq!(json["strategy"], "squash");

        // 7. GitFinalizeComplete
        let event = SessionEvent::GitFinalizeComplete;
        let json = serde_json::to_value(&event).expect("serialize GitFinalizeComplete");
        assert_eq!(json["kind"], "git_finalize_complete");

        // 8. OneShotComplete
        let event = SessionEvent::OneShotComplete;
        let json = serde_json::to_value(&event).expect("serialize OneShotComplete");
        assert_eq!(json["kind"], "one_shot_complete");

        // 9. OneShotFailed
        let event = SessionEvent::OneShotFailed {
            reason: "Design phase timed out".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize OneShotFailed");
        assert_eq!(json["kind"], "one_shot_failed");
        assert_eq!(json["reason"], "Design phase timed out");
    }

    // =========================================================================
    // Git sync data model tests
    // =========================================================================

    #[test]
    fn git_sync_config_default_values() {
        let config = GitSyncConfig::default();
        assert_eq!(config.enabled, false);
        assert_eq!(config.conflict_prompt, None);
        assert_eq!(config.model, None);
        assert_eq!(config.max_push_retries, 3);
    }

    #[test]
    fn git_sync_config_serializes_correctly() {
        let config = GitSyncConfig {
            enabled: true,
            conflict_prompt: Some("Resolve these merge conflicts".to_string()),
            model: Some("sonnet".to_string()),
            max_push_retries: 5,
        };

        let json = serde_json::to_value(&config).expect("serialize GitSyncConfig");
        assert_eq!(json["enabled"], true);
        assert_eq!(json["conflictPrompt"], "Resolve these merge conflicts");
        assert_eq!(json["model"], "sonnet");
        assert_eq!(json["maxPushRetries"], 5);
    }

    #[test]
    fn git_sync_config_deserializes_from_json() {
        let json = serde_json::json!({
            "enabled": true,
            "conflictPrompt": "Fix conflicts please",
            "model": "opus",
            "maxPushRetries": 7
        });

        let config: GitSyncConfig = serde_json::from_value(json).expect("deserialize GitSyncConfig");
        assert_eq!(config.enabled, true);
        assert_eq!(config.conflict_prompt, Some("Fix conflicts please".to_string()));
        assert_eq!(config.model, Some("opus".to_string()));
        assert_eq!(config.max_push_retries, 7);
    }

    #[test]
    fn git_sync_config_deserializes_with_optional_fields_absent() {
        let json = serde_json::json!({
            "enabled": false,
            "maxPushRetries": 2
        });

        let config: GitSyncConfig = serde_json::from_value(json).expect("deserialize GitSyncConfig with absent optionals");
        assert_eq!(config.enabled, false);
        assert_eq!(config.conflict_prompt, None);
        assert_eq!(config.model, None);
        assert_eq!(config.max_push_retries, 2);
    }

    #[test]
    fn session_config_default_has_no_git_sync() {
        let config = SessionConfig::default();
        assert!(config.git_sync.is_none(), "default git_sync should be None");
    }

    #[test]
    fn git_sync_started_event_serializes_correctly() {
        let event = SessionEvent::GitSyncStarted { iteration: 1 };
        let json = serde_json::to_value(&event).expect("serialize GitSyncStarted");
        assert_eq!(json["kind"], "git_sync_started");
        assert_eq!(json["iteration"], 1);
    }

    #[test]
    fn git_sync_push_succeeded_event_serializes_correctly() {
        let event = SessionEvent::GitSyncPushSucceeded { iteration: 2 };
        let json = serde_json::to_value(&event).expect("serialize GitSyncPushSucceeded");
        assert_eq!(json["kind"], "git_sync_push_succeeded");
        assert_eq!(json["iteration"], 2);
    }

    #[test]
    fn git_sync_conflict_event_serializes_correctly() {
        let event = SessionEvent::GitSyncConflict {
            iteration: 3,
            files: vec!["src/main.rs".to_string(), "Cargo.toml".to_string()],
        };
        let json = serde_json::to_value(&event).expect("serialize GitSyncConflict");
        assert_eq!(json["kind"], "git_sync_conflict");
        assert_eq!(json["iteration"], 3);
        assert_eq!(json["files"], serde_json::json!(["src/main.rs", "Cargo.toml"]));
    }

    #[test]
    fn git_sync_conflict_resolve_started_event_serializes_correctly() {
        let event = SessionEvent::GitSyncConflictResolveStarted {
            iteration: 4,
            attempt: 1,
        };
        let json = serde_json::to_value(&event).expect("serialize GitSyncConflictResolveStarted");
        assert_eq!(json["kind"], "git_sync_conflict_resolve_started");
        assert_eq!(json["iteration"], 4);
        assert_eq!(json["attempt"], 1);
    }

    #[test]
    fn git_sync_conflict_resolve_complete_event_serializes_correctly() {
        let event_success = SessionEvent::GitSyncConflictResolveComplete {
            iteration: 5,
            attempt: 2,
            success: true,
        };
        let json_success = serde_json::to_value(&event_success).expect("serialize GitSyncConflictResolveComplete success");
        assert_eq!(json_success["kind"], "git_sync_conflict_resolve_complete");
        assert_eq!(json_success["iteration"], 5);
        assert_eq!(json_success["attempt"], 2);
        assert_eq!(json_success["success"], true);

        let event_failure = SessionEvent::GitSyncConflictResolveComplete {
            iteration: 6,
            attempt: 3,
            success: false,
        };
        let json_failure = serde_json::to_value(&event_failure).expect("serialize GitSyncConflictResolveComplete failure");
        assert_eq!(json_failure["kind"], "git_sync_conflict_resolve_complete");
        assert_eq!(json_failure["iteration"], 6);
        assert_eq!(json_failure["attempt"], 3);
        assert_eq!(json_failure["success"], false);
    }

    #[test]
    fn git_sync_failed_event_serializes_correctly() {
        let event = SessionEvent::GitSyncFailed {
            iteration: 7,
            error: "push rejected after max retries".to_string(),
        };
        let json = serde_json::to_value(&event).expect("serialize GitSyncFailed");
        assert_eq!(json["kind"], "git_sync_failed");
        assert_eq!(json["iteration"], 7);
        assert_eq!(json["error"], "push rejected after max retries");
    }

    #[test]
    fn all_git_sync_event_variants_roundtrip_through_json() {
        let events = vec![
            SessionEvent::GitSyncStarted { iteration: 1 },
            SessionEvent::GitSyncPushSucceeded { iteration: 1 },
            SessionEvent::GitSyncConflict {
                iteration: 2,
                files: vec!["src/lib.rs".to_string(), "README.md".to_string()],
            },
            SessionEvent::GitSyncConflictResolveStarted { iteration: 2, attempt: 1 },
            SessionEvent::GitSyncConflictResolveComplete { iteration: 2, attempt: 1, success: true },
            SessionEvent::GitSyncFailed {
                iteration: 3,
                error: "network error".to_string(),
            },
        ];

        for event in &events {
            let json_str = serde_json::to_string(event).expect("serialize event");
            let deserialized: SessionEvent = serde_json::from_str(&json_str).expect("deserialize event");
            let original_value = serde_json::to_value(event).expect("to_value original");
            let roundtrip_value = serde_json::to_value(&deserialized).expect("to_value roundtrip");
            assert_eq!(original_value, roundtrip_value, "roundtrip failed for {:?}", event);
        }
    }

    #[tokio::test]
    async fn no_checks_configured_produces_no_check_events() {
        let tmp = TempDir::new().expect("create temp dir");

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(), // No checks
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let runtime = MockRuntime::completing_after(1);
        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // Should have no check-related events at all
        let check_event_count = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    SessionEvent::CheckStarted { .. }
                        | SessionEvent::CheckPassed { .. }
                        | SessionEvent::CheckFailed { .. }
                        | SessionEvent::CheckFixStarted { .. }
                        | SessionEvent::CheckFixComplete { .. }
                )
            })
            .count();
        assert_eq!(
            check_event_count, 0,
            "should have no check events when no checks configured, got {}",
            check_event_count
        );
    }

    // =========================================================================
    // git_sync method
    // =========================================================================

    fn make_runner_with_git_sync(tmp: &TempDir, git_sync: Option<GitSyncConfig>) -> SessionRunner {
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync,
            iteration_offset: 0,
        };
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        SessionRunner::new(config, collector, cancel_token)
    }

    #[tokio::test]
    async fn git_sync_skipped_when_none() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(&tmp, None);

        let runtime = MockRuntime::completing_after(1);
        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.is_empty(),
            "no events should be emitted when git_sync is None, got: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn git_sync_skipped_when_disabled() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: false,
                ..Default::default()
            }),
        );

        let runtime = MockRuntime::completing_after(1);
        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.is_empty(),
            "no events should be emitted when git_sync is disabled, got: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn git_sync_successful_push() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Branch detection: git branch --show-current
            CommandOutput {
                exit_code: 0,
                stdout: "main\n".to_string(),
                stderr: String::new(),
            },
            // 2. Push: git push origin main — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert_eq!(events.len(), 2, "should emit exactly 2 events, got: {:?}", events);
        assert!(
            matches!(&events[0], SessionEvent::GitSyncStarted { iteration: 1 }),
            "first event should be GitSyncStarted {{ iteration: 1 }}, got: {:?}",
            events[0]
        );
        assert!(
            matches!(&events[1], SessionEvent::GitSyncPushSucceeded { iteration: 1 }),
            "second event should be GitSyncPushSucceeded {{ iteration: 1 }}, got: {:?}",
            events[1]
        );
    }

    #[tokio::test]
    async fn git_sync_push_fails_push_with_upstream_succeeds() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Branch detection
            CommandOutput {
                exit_code: 0,
                stdout: "feature-branch\n".to_string(),
                stderr: String::new(),
            },
            // 2. First push (git push origin feature-branch) — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: failed to push".to_string(),
            },
            // 3. Push with -u (git push -u origin feature-branch) — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncStarted { iteration: 1 })),
            "should emit GitSyncStarted, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { iteration: 1 })),
            "should emit GitSyncPushSucceeded after push -u succeeds, got: {:?}",
            events
        );
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::GitSyncFailed { .. })),
            "should not emit GitSyncFailed, got: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn git_sync_push_fails_rebase_succeeds_then_push_succeeds() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Branch detection
            CommandOutput {
                exit_code: 0,
                stdout: "main\n".to_string(),
                stderr: String::new(),
            },
            // 2. First push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 3. Push -u — also fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 4. Fetch: git fetch origin main
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. Pull --rebase: git pull --rebase origin main — succeeds cleanly
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 6. Retry push — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncStarted { iteration: 1 })),
            "should emit GitSyncStarted, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { iteration: 1 })),
            "should emit GitSyncPushSucceeded after rebase + retry push, got: {:?}",
            events
        );
        // No conflict events should be emitted for a clean rebase
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::GitSyncConflict { .. })),
            "should not emit GitSyncConflict when rebase succeeds cleanly, got: {:?}",
            events
        );
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::GitSyncFailed { .. })),
            "should not emit GitSyncFailed, got: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn git_sync_all_retries_exhausted() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                max_push_retries: 1,
                ..Default::default()
            }),
        );

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Branch detection
            CommandOutput {
                exit_code: 0,
                stdout: "main\n".to_string(),
                stderr: String::new(),
            },
            // 2. First push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 3. Push -u — also fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 4. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. Pull --rebase — succeeds (no conflicts)
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 6. Retry push — still fails (max_push_retries=1, only retry exhausted)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
        ];

        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncStarted { iteration: 1 })),
            "should emit GitSyncStarted, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::GitSyncFailed { iteration: 1, .. })),
            "should emit GitSyncFailed after all retries exhausted, got: {:?}",
            events
        );
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. })),
            "should not emit GitSyncPushSucceeded when all retries fail, got: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn git_sync_conflict_resolved_successfully() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Branch detection: git branch --show-current
            CommandOutput {
                exit_code: 0,
                stdout: "feature-branch\n".to_string(),
                stderr: String::new(),
            },
            // 2. First push: git push origin feature-branch — fails (rejected)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 3. Push -u: git push -u origin feature-branch — also fails (rejected)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 4. Fetch: git fetch origin feature-branch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 5. Rebase: git pull --rebase origin feature-branch — fails with CONFLICT
            CommandOutput {
                exit_code: 1,
                stdout: "CONFLICT (content): Merge conflict in src/app.rs\n".to_string(),
                stderr: String::new(),
            },
            // 6. git status — shows unmerged paths
            CommandOutput {
                exit_code: 0,
                stdout: "Unmerged paths:\n  both modified:   src/app.rs\n".to_string(),
                stderr: String::new(),
            },
            // 7. git diff --name-only --diff-filter=U — returns conflicted files
            CommandOutput {
                exit_code: 0,
                stdout: "src/app.rs\n".to_string(),
                stderr: String::new(),
            },
            // 8. (Claude is spawned via spawn_claude — MockRuntime handles this automatically)
            // 9. Post-resolution git status — clean state, no "rebase in progress"
            CommandOutput {
                exit_code: 0,
                stdout: "On branch feature-branch\nnothing to commit, working tree clean\n".to_string(),
                stderr: String::new(),
            },
            // 10. Push after conflict resolution: git push origin feature-branch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncStarted { iteration: 1 })),
            "should emit GitSyncStarted, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                SessionEvent::GitSyncConflict {
                    iteration: 1,
                    files
                } if files == &vec!["src/app.rs".to_string()]
            )),
            "should emit GitSyncConflict with conflicted files, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                SessionEvent::GitSyncConflictResolveStarted {
                    iteration: 1,
                    attempt: 1
                }
            )),
            "should emit GitSyncConflictResolveStarted, got: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                SessionEvent::GitSyncConflictResolveComplete {
                    iteration: 1,
                    attempt: 1,
                    success: true
                }
            )),
            "should emit GitSyncConflictResolveComplete with success: true, got: {:?}",
            events
        );
        assert!(
            events
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { iteration: 1 })),
            "should emit GitSyncPushSucceeded, got: {:?}",
            events
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, SessionEvent::GitSyncFailed { .. })),
            "should NOT emit GitSyncFailed, got: {:?}",
            events
        );
    }

    /// Helper: generates command_results for N successful git_sync calls.
    /// Each call consumes 2 results: branch detection + push.
    fn git_sync_success_results(count: usize) -> Vec<CommandOutput> {
        let mut results = Vec::new();
        for _ in 0..count {
            results.push(CommandOutput {
                exit_code: 0,
                stdout: "feature-branch\n".to_string(),
                stderr: String::new(),
            });
            results.push(CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        results
    }

    #[tokio::test]
    async fn git_sync_skipped_when_cancelled() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
            iteration_offset: 0,
        };
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        // Cancel BEFORE calling git_sync
        cancel_token.cancel();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let runtime = MockRuntime::completing_after(1);
        runner.git_sync(&runtime, 1).await;

        let events = get_events(&runner);
        assert!(
            events.is_empty(),
            "no events should be emitted when cancel token is already cancelled, got: {:?}",
            events
        );
    }

    // =========================================================================
    // Task 5: git_sync integration into session loop
    // =========================================================================

    #[tokio::test]
    async fn git_sync_runs_after_each_iteration_in_loop() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        // 2 working iterations + 1 completion = 3 total iterations
        // git_sync runs:
        //   - after EachIteration checks on iteration 1
        //   - after EachIteration checks on iteration 2
        //   - after EachIteration checks on iteration 3 (completion)
        //   - after PostCompletion checks on iteration 3
        // Total: 4 git_sync calls = 8 command results
        let mut runtime = MockRuntime::completing_after(2);
        runtime.command_results = git_sync_success_results(4);

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // Count GitSyncStarted events — should be 4
        let git_sync_started_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::GitSyncStarted { .. }))
            .count();
        assert_eq!(
            git_sync_started_count, 4,
            "should have 4 GitSyncStarted events (3 EachIteration + 1 PostCompletion), got {}",
            git_sync_started_count
        );

        // Count GitSyncPushSucceeded events — should be 4
        let push_succeeded_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. }))
            .count();
        assert_eq!(
            push_succeeded_count, 4,
            "should have 4 GitSyncPushSucceeded events, got {}",
            push_succeeded_count
        );

        // Verify ordering: each GitSyncStarted should come after its IterationComplete
        let mut last_iteration_complete_idx: Option<usize> = None;
        for (idx, event) in events.iter().enumerate() {
            if matches!(event, SessionEvent::IterationComplete { .. }) {
                last_iteration_complete_idx = Some(idx);
            }
            if matches!(event, SessionEvent::GitSyncStarted { .. }) {
                assert!(
                    last_iteration_complete_idx.is_some(),
                    "GitSyncStarted at index {} should come after an IterationComplete",
                    idx
                );
            }
        }
    }

    #[tokio::test]
    async fn git_sync_runs_after_completion_signal() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(
            &tmp,
            Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
        );

        // Completes on first iteration
        // git_sync runs:
        //   - after EachIteration checks on iteration 1
        //   - after PostCompletion checks on iteration 1
        // Total: 2 git_sync calls = 4 command results
        let mut runtime = MockRuntime::completing_after(0);
        runtime.command_results = git_sync_success_results(2);

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        // Should have exactly 2 GitSyncStarted events
        let git_sync_started_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::GitSyncStarted { .. }))
            .count();
        assert_eq!(
            git_sync_started_count, 2,
            "should have 2 GitSyncStarted events (EachIteration + PostCompletion), got {}",
            git_sync_started_count
        );

        // The last GitSyncPushSucceeded should come before SessionComplete
        let last_push_succeeded_idx = events
            .iter()
            .rposition(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. }))
            .expect("should have at least one GitSyncPushSucceeded");

        let session_complete_idx = events
            .iter()
            .position(|e| matches!(e, SessionEvent::SessionComplete { .. }))
            .expect("should have SessionComplete");

        assert!(
            last_push_succeeded_idx < session_complete_idx,
            "last GitSyncPushSucceeded (idx={}) should come before SessionComplete (idx={})",
            last_push_succeeded_idx,
            session_complete_idx
        );
    }

    #[tokio::test]
    async fn git_sync_runs_on_session_exit_max_iterations() {
        let tmp = TempDir::new().expect("create temp dir");

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 2,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: Some(GitSyncConfig {
                enabled: true,
                ..Default::default()
            }),
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        // Never completes — will hit max_iterations=2
        // git_sync runs:
        //   - after EachIteration checks on iteration 1
        //   - after EachIteration checks on iteration 2
        //   - session-exit git_sync (MaxIterations)
        // Total: 3 git_sync calls = 6 command results
        let mut runtime = MockRuntime::completing_after(999);
        runtime.command_results = git_sync_success_results(3);

        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::MaxIterationsReached);

        let events = get_events(&runner);

        // Should have 3 GitSyncStarted events (2 EachIteration + 1 session-exit)
        let git_sync_started_count = events
            .iter()
            .filter(|e| matches!(e, SessionEvent::GitSyncStarted { .. }))
            .count();
        assert_eq!(
            git_sync_started_count, 3,
            "should have 3 GitSyncStarted events (2 EachIteration + 1 session-exit), got {}",
            git_sync_started_count
        );

        // The session-exit GitSyncPushSucceeded should come before SessionComplete
        let last_push_succeeded_idx = events
            .iter()
            .rposition(|e| matches!(e, SessionEvent::GitSyncPushSucceeded { .. }))
            .expect("should have at least one GitSyncPushSucceeded");

        let session_complete_idx = events
            .iter()
            .position(|e| matches!(e, SessionEvent::SessionComplete { .. }))
            .expect("should have SessionComplete");

        assert!(
            last_push_succeeded_idx < session_complete_idx,
            "session-exit GitSyncPushSucceeded (idx={}) should come before SessionComplete (idx={})",
            last_push_succeeded_idx,
            session_complete_idx
        );
    }

    #[tokio::test]
    async fn no_git_sync_events_when_not_configured() {
        let tmp = TempDir::new().expect("create temp dir");
        let runner = make_runner_with_git_sync(&tmp, None);

        let runtime = MockRuntime::completing_after(1);
        let trace = runner.run(&runtime).await.expect("run should succeed");
        assert_eq!(trace.outcome, SessionOutcome::Completed);

        let events = get_events(&runner);

        let git_sync_event_count = events
            .iter()
            .filter(|e| {
                matches!(
                    e,
                    SessionEvent::GitSyncStarted { .. }
                        | SessionEvent::GitSyncPushSucceeded { .. }
                        | SessionEvent::GitSyncConflict { .. }
                        | SessionEvent::GitSyncConflictResolveStarted { .. }
                        | SessionEvent::GitSyncConflictResolveComplete { .. }
                        | SessionEvent::GitSyncFailed { .. }
                )
            })
            .count();
        assert_eq!(
            git_sync_event_count, 0,
            "should have no git sync events when git_sync is None, got {}",
            git_sync_event_count
        );
    }

    // =========================================================================
    // working_dir override tests
    // =========================================================================

    #[test]
    fn session_config_default_has_no_working_dir() {
        let config = SessionConfig::default();
        assert!(
            config.working_dir.is_none(),
            "default working_dir should be None"
        );
    }

    #[test]
    fn effective_working_dir_returns_repo_path_when_working_dir_is_none() {
        let config = SessionConfig {
            repo_path: PathBuf::from("/my/repo"),
            working_dir: None,
            ..SessionConfig::default()
        };
        assert_eq!(
            config.effective_working_dir(),
            std::path::Path::new("/my/repo"),
            "effective_working_dir should fall back to repo_path when working_dir is None"
        );
    }

    #[test]
    fn effective_working_dir_returns_working_dir_when_set() {
        let config = SessionConfig {
            repo_path: PathBuf::from("/my/repo"),
            working_dir: Some(PathBuf::from("/custom/working/dir")),
            ..SessionConfig::default()
        };
        assert_eq!(
            config.effective_working_dir(),
            std::path::Path::new("/custom/working/dir"),
            "effective_working_dir should return working_dir when it is Some"
        );
    }

    // =========================================================================
    // run_with_trace: decoupled trace lifecycle
    // =========================================================================

    /// Helper: create a SessionRunner and a pre-started trace for run_with_trace tests.
    /// Returns (runner, trace) where the trace was created from a separate collector
    /// using the same base_dir/repo_id.
    fn make_runner_and_trace(
        tmp: &TempDir,
        checks: Vec<Check>,
    ) -> (SessionRunner, trace::SessionTrace) {
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let trace = collector.start_session("/mock/project", "Test prompt", None);
        let runner = make_runner(tmp, checks);
        (runner, trace)
    }

    #[tokio::test]
    async fn run_with_trace_does_not_emit_session_lifecycle_events() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, mut trace) = make_runner_and_trace(&tmp, vec![]);

        let runtime = MockRuntime::completing_after(1);

        runner
            .run_with_trace(&runtime, &mut trace)
            .await
            .expect("run_with_trace should succeed");

        let events = get_events(&runner);

        // Should NOT have SessionStarted or SessionComplete events
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::SessionStarted { .. })),
            "run_with_trace should not emit SessionStarted, events: {:?}",
            events
        );
        assert!(
            !events.iter().any(|e| matches!(e, SessionEvent::SessionComplete { .. })),
            "run_with_trace should not emit SessionComplete, events: {:?}",
            events
        );

        // SHOULD have iteration-level events
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::IterationStarted { .. })),
            "run_with_trace should emit IterationStarted, events: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::ToolUse { .. })),
            "run_with_trace should emit ToolUse, events: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::AssistantText { .. })),
            "run_with_trace should emit AssistantText, events: {:?}",
            events
        );
        assert!(
            events.iter().any(|e| matches!(e, SessionEvent::IterationComplete { .. })),
            "run_with_trace should emit IterationComplete, events: {:?}",
            events
        );
    }

    #[tokio::test]
    async fn run_with_trace_records_iterations_to_provided_trace() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, mut trace) = make_runner_and_trace(&tmp, vec![]);

        // 2 working iterations + 1 completion = 3 total iterations
        let runtime = MockRuntime::completing_after(2);

        runner
            .run_with_trace(&runtime, &mut trace)
            .await
            .expect("run_with_trace should succeed");

        assert_eq!(
            trace.total_iterations, 3,
            "trace should have 3 total iterations (2 working + 1 completion)"
        );
        assert_eq!(
            trace.outcome,
            SessionOutcome::Completed,
            "trace outcome should be Completed"
        );
        assert_eq!(
            trace.iterations.len(),
            3,
            "trace.iterations should have 3 entries"
        );
    }

    #[tokio::test]
    async fn run_with_trace_does_not_finalize_trace() {
        let tmp = TempDir::new().expect("create temp dir");
        let (runner, mut trace) = make_runner_and_trace(&tmp, vec![]);

        let runtime = MockRuntime::completing_after(1);

        runner
            .run_with_trace(&runtime, &mut trace)
            .await
            .expect("run_with_trace should succeed");

        // end_time should still be None because finalize was not called
        assert!(
            trace.end_time.is_none(),
            "trace.end_time should be None (finalize not called), got: {:?}",
            trace.end_time
        );

        // No trace files should be written to disk
        let traces_dir = tmp.path().join("traces").join("test-repo");
        if traces_dir.exists() {
            let entries: Vec<_> = std::fs::read_dir(&traces_dir)
                .expect("read traces dir")
                .filter_map(|e| e.ok())
                .collect();
            assert!(
                entries.is_empty(),
                "no trace files should be written to disk by run_with_trace, found: {:?}",
                entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
            );
        }
        // If the traces dir doesn't exist at all, that's also correct
    }

    #[tokio::test]
    async fn run_still_works_unchanged() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(2); // 2 working + 1 completion = 3 iters
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let trace = runner.run(&runtime).await.expect("run should succeed");

        // run() should still produce a complete trace
        assert_eq!(trace.outcome, SessionOutcome::Completed);
        assert_eq!(trace.total_iterations, 3);
        assert_eq!(trace.iterations.len(), 3);

        // run() should set end_time via finalize
        assert!(
            trace.end_time.is_some(),
            "run() should set end_time via finalize"
        );

        let events = get_events(&runner);

        // run() should emit SessionStarted as first event
        match &events[0] {
            SessionEvent::SessionStarted { .. } => {}
            other => panic!("expected SessionStarted as first event, got {:?}", other),
        }

        // run() should emit SessionComplete as last event
        match events.last().unwrap() {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
                assert_eq!(*plan_file, None, "plan_file should be None when not set in config");
            }
            other => panic!("expected SessionComplete as last event, got {:?}", other),
        }

        // run() should write trace files to disk
        let trace_file = base_dir
            .join("traces")
            .join("test-repo")
            .join(format!("trace_{}.json", trace.session_id));
        assert!(
            trace_file.exists(),
            "run() should write trace file to disk at {:?}",
            trace_file
        );

        let events_file = base_dir
            .join("traces")
            .join("test-repo")
            .join(format!("events_{}.jsonl", trace.session_id));
        assert!(
            events_file.exists(),
            "run() should write events file to disk at {:?}",
            events_file
        );
    }

    #[tokio::test]
    async fn test_session_complete_carries_plan_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(1);
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: Some("docs/plans/my-plan.md".to_string()),
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let _trace = runner.run(&runtime).await.expect("run should succeed");
        let events = get_events(&runner);

        // Find the SessionComplete event and verify plan_file is carried through
        let complete_event = events
            .iter()
            .find(|e| matches!(e, SessionEvent::SessionComplete { .. }))
            .expect("should have SessionComplete event");

        match complete_event {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
                assert_eq!(
                    *plan_file,
                    Some("docs/plans/my-plan.md".to_string()),
                    "SessionComplete should carry the plan_file from config"
                );
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn test_session_complete_plan_file_none_when_not_set() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(1);
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            effort_level: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let _trace = runner.run(&runtime).await.expect("run should succeed");
        let events = get_events(&runner);

        // Find the SessionComplete event and verify plan_file is None
        let complete_event = events
            .iter()
            .find(|e| matches!(e, SessionEvent::SessionComplete { .. }))
            .expect("should have SessionComplete event");

        match complete_event {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
                assert_eq!(
                    *plan_file, None,
                    "SessionComplete should have plan_file None when not set in config"
                );
            }
            _ => unreachable!(),
        }
    }

    #[tokio::test]
    async fn test_plan_content_snapshot_happy_path() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // Create a plan file on disk with known content
        let plan_dir = tmp.path().join("plans");
        std::fs::create_dir_all(&plan_dir).expect("create plans dir");
        let plan_path = plan_dir.join("my-plan.md");
        let plan_text = "# My Plan\n\nThis is the plan content.\n";
        std::fs::write(&plan_path, plan_text).expect("write plan file");

        let runtime = MockRuntime::completing_after(1);
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: Some(plan_path.to_string_lossy().to_string()),
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let trace = runner.run(&runtime).await.expect("run should succeed");

        assert_eq!(
            trace.plan_content,
            Some(plan_text.to_string()),
            "trace.plan_content should contain the plan file contents"
        );
    }

    #[tokio::test]
    async fn test_plan_content_snapshot_file_not_found() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(1);
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: Some("/nonexistent/path/plan.md".to_string()),
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let trace = runner.run(&runtime).await.expect("run should succeed even when plan file is missing");

        assert_eq!(
            trace.plan_content, None,
            "trace.plan_content should be None when the plan file does not exist"
        );
    }

    #[tokio::test]
    async fn test_plan_content_snapshot_no_plan_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let runtime = MockRuntime::completing_after(1);
        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
            iteration_offset: 0,
        };

        let collector = TraceCollector::new(base_dir, "test-repo");
        let cancel_token = tokio_util::sync::CancellationToken::new();
        let runner = SessionRunner::new(config, collector, cancel_token);

        let trace = runner.run(&runtime).await.expect("run should succeed");

        assert_eq!(
            trace.plan_content, None,
            "trace.plan_content should be None when no plan_file is configured"
        );
    }
}
