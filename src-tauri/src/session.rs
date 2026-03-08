use anyhow::Result;
use chrono::Utc;
use std::path::PathBuf;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

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

/// Configuration for a Ralph loop session
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub repo_path: PathBuf,
    pub prompt: String,
    pub max_iterations: u32,
    pub completion_signal: String,
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    /// Plan file path (if any)
    pub plan_file: Option<String>,
    /// Delay between iterations (rate limit protection)
    pub inter_iteration_delay_ms: u64,
    /// Extra environment variables to set when spawning Claude
    pub env_vars: std::collections::HashMap<String, String>,
    pub checks: Vec<Check>,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            repo_path: PathBuf::from("."),
            prompt: String::new(),
            max_iterations: 20,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: Vec::new(),
            plan_file: None,
            inter_iteration_delay_ms: 1000,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
        }
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
    Disconnected { iteration: u32 },
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
    /// The entire session finished
    SessionComplete { outcome: SessionOutcome },
    /// SSH connection lost, session may still be running remotely
    Disconnected { iteration: u32 },
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

    fn unregister_abort(&self, handle: &std::sync::Arc<dyn crate::runtime::AbortHandle>) {
        if let Some(ref registry) = self.abort_registry {
            let mut handles = registry.lock().unwrap();
            handles.retain(|h| !std::sync::Arc::ptr_eq(h, handle));
        }
    }

    fn emit(&self, event: SessionEvent) {
        self.accumulated_events.lock().unwrap().push(event.clone());
        if let Some(ref cb) = self.on_event {
            cb(&event);
        }
    }

    fn build_invocation(&self) -> ClaudeInvocation {
        ClaudeInvocation {
            prompt: self.config.prompt.clone(),
            working_dir: self.config.repo_path.clone(),
            model: self.config.model.clone(),
            extra_args: self.config.extra_args.clone(),
            env_vars: self.config.env_vars.clone(),
        }
    }

    async fn run_checks(
        &self,
        runtime: &dyn RuntimeProvider,
        iteration: u32,
        when: &CheckWhen,
        checks: &[Check],
    ) {
        let matching: Vec<&Check> = checks.iter().filter(|c| &c.when == when).collect();

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
                    &self.config.repo_path,
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
                    working_dir: self.config.repo_path.clone(),
                    model: check.model.clone().or_else(|| self.config.model.clone()),
                    extra_args: vec!["--dangerously-skip-permissions".to_string()],
                    env_vars: self.config.env_vars.clone(),
                };

                match runtime.spawn_claude(&fix_invocation).await {
                    Ok(mut process) => {
                        // Drain events channel
                        while process.events.recv().await.is_some() {}
                        // Wait for completion
                        let _ = process.completion.await;

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
                        &self.config.repo_path,
                        Duration::from_secs(check.timeout_secs as u64),
                    )
                    .await;

                match recheck {
                    Ok(recheck_output) => {
                        if recheck_output.exit_code == 0 {
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

    /// Execute the Ralph loop. Returns the finalized trace.
    pub async fn run(
        &self,
        runtime: &dyn RuntimeProvider,
    ) -> Result<trace::SessionTrace> {
        runtime.health_check().await?;

        let repo_str = self.config.repo_path.to_string_lossy().to_string();
        let mut trace = self.collector.start_session(&repo_str, &self.config.prompt, self.config.plan_file.as_deref());

        println!(
            "[harness] Starting Ralph loop on '{}' (max {} iterations)",
            repo_str, self.config.max_iterations
        );
        println!("[harness] Runtime: {}", runtime.name());
        println!(
            "[harness] Completion signal: {}",
            self.config.completion_signal
        );
        if let Some(ref model) = self.config.model {
            println!("[harness] Model: {model}");
        }
        println!();

        self.emit(SessionEvent::SessionStarted {
            session_id: trace.session_id.clone(),
        });

        let mut state = SessionState::Idle;
        let invocation = self.build_invocation();

        for iteration in 1..=self.config.max_iterations {
            // Check cancellation before starting iteration
            if self.cancel_token.is_cancelled() {
                println!("[harness] Session cancelled before iteration {iteration}.");
                state = SessionState::Cancelled { iteration };
                break;
            }

            let _ = SessionState::Running { iteration };
            println!(
                "[harness] === Iteration {}/{} ===",
                iteration, self.config.max_iterations
            );

            self.emit(SessionEvent::IterationStarted { iteration });

            let iter_start = Utc::now();

            match self.run_iteration(runtime, &invocation, iteration).await {
                Ok(result) => {
                    let iter_end = Utc::now();
                    let has_signal =
                        result.has_completion_signal(&self.config.completion_signal);
                    let is_error = result.is_error;
                    let result_text = result.result_text();

                    self.collector.record_iteration(
                        &mut trace,
                        iter_start,
                        iter_end,
                        SpanAttributes {
                            iteration,
                            claude_session_id: result.session_id.clone(),
                            cost_usd: result.total_cost_usd.unwrap_or(0.0),
                            num_turns: result.num_turns,
                            api_duration_ms: result.duration_api_ms,
                            completion_signal_found: has_signal,
                            exit_code: 0,
                            result_preview: result_text[..result_text.len().min(500)].to_string(),
                            token_usage: result.token_usage(),
                            model_token_usage: result.model_token_usage(),
                        },
                        is_error,
                    );

                    self.emit(SessionEvent::IterationComplete {
                        iteration,
                        result: result.clone(),
                    });

                    println!(
                        "[harness] Iteration {iteration} complete: cost=${:.4}, turns={}, signal={has_signal}",
                        result.total_cost_usd.unwrap_or(0.0),
                        result.num_turns.unwrap_or(0),
                    );

                    state = SessionState::Evaluating { iteration };

                    self.run_checks(runtime, iteration, &CheckWhen::EachIteration, &self.config.checks).await;

                    if self.cancel_token.is_cancelled() {
                        println!("[harness] Session cancelled after checks in iteration {iteration}.");
                        state = SessionState::Cancelled { iteration };
                        break;
                    }

                    if has_signal {
                        println!("[harness] Completion signal detected! Stopping loop.");
                        self.run_checks(runtime, iteration, &CheckWhen::PostCompletion, &self.config.checks).await;
                        state = SessionState::Completed {
                            iterations: iteration,
                        };
                        break;
                    }

                    if is_error {
                        eprintln!("[harness] Error detected in iteration {iteration}");
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
                                println!("[harness] Session cancelled during inter-iteration delay.");
                                state = SessionState::Cancelled { iteration };
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    // Check if this was a cancellation-induced error
                    if self.cancel_token.is_cancelled() {
                        println!("[harness] Session cancelled during iteration {iteration}.");
                        state = SessionState::Cancelled { iteration };
                        break;
                    }

                    let iter_end = Utc::now();
                    eprintln!("[harness] Process error on iteration {iteration}: {e}");

                    self.collector.record_iteration(
                        &mut trace,
                        iter_start,
                        iter_end,
                        SpanAttributes {
                            iteration,
                            claude_session_id: None,
                            cost_usd: 0.0,
                            num_turns: None,
                            api_duration_ms: None,
                            completion_signal_found: false,
                            exit_code: -1,
                            result_preview: format!("Process error: {e}"),
                            token_usage: Default::default(),
                            model_token_usage: Default::default(),
                        },
                        true,
                    );

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
            println!(
                "[harness] Max iterations ({}) reached without completion signal.",
                self.config.max_iterations
            );
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

        let outcome = trace.outcome.clone();
        self.emit(SessionEvent::SessionComplete { outcome });

        let events: Vec<SessionEvent> = {
            let guard = self.accumulated_events.lock().unwrap();
            guard.clone()
        };
        let trace_path = self.collector.finalize(&mut trace, &events).await?;
        println!("\n[harness] Trace saved to: {}", trace_path.display());

        trace::print_trace_summary(&trace);

        Ok(trace)
    }

    /// Run a single iteration: spawn Claude, consume streaming events, return the final result.
    async fn run_iteration(
        &self,
        runtime: &dyn RuntimeProvider,
        invocation: &ClaudeInvocation,
        iteration: u32,
    ) -> Result<ResultEvent> {
        let mut process = runtime.spawn_claude(invocation).await?;
        let mut result_event: Option<ResultEvent> = None;

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
                    match &event {
                        StreamEvent::System(sys) => {
                            if let Some(ref model) = sys.model {
                                tracing::debug!("Iteration {iteration}: model={model}");
                            }
                        }
                        StreamEvent::Assistant(assistant) => {
                            for block in &assistant.message.content {
                                match block {
                                    ContentBlock::ToolUse { name, input, .. } => {
                                        println!("  [{iteration}] tool: {name}");
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
                                        println!("  [{iteration}] text: {preview}");
                                        self.emit(SessionEvent::AssistantText {
                                            iteration,
                                            text: text.clone(),
                                        });
                                    }
                                    ContentBlock::Unknown => {}
                                }
                            }
                        }
                        StreamEvent::RateLimit(rl) => {
                            if let Some(ref info) = rl.rate_limit_info {
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

        if exit.exit_code != 0 && result_event.is_none() {
            anyhow::bail!(
                "Claude process exited with code {} (stderr: {})",
                exit.exit_code,
                exit.stderr.trim()
            );
        }

        result_event.ok_or_else(|| {
            anyhow::anyhow!("Claude process exited without emitting a result event")
        })
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
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0, // no delay for tests
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
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
            SessionEvent::SessionComplete { outcome } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
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
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks,
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
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
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
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
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
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: vec![check],
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

    #[tokio::test]
    async fn no_checks_configured_produces_no_check_events() {
        let tmp = TempDir::new().expect("create temp dir");

        let config = SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            prompt: "Test prompt".to_string(),
            max_iterations: 10,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(), // No checks
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
}
