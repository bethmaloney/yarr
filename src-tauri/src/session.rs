use anyhow::Result;
use chrono::Utc;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

use crate::output::{ContentBlock, ResultEvent, StreamEvent};
use crate::runtime::{ClaudeInvocation, RuntimeProvider};
use crate::trace::{self, SessionOutcome, SpanAttributes, TraceCollector};

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
    ToolUse { iteration: u32, tool_name: String },
    /// Claude produced text output
    AssistantText { iteration: u32, text: String },
    /// An iteration completed with its result
    IterationComplete { iteration: u32, result: ResultEvent },
    /// The entire session finished
    SessionComplete { outcome: SessionOutcome },
}

/// Callback for receiving session events (Tauri IPC hookpoint)
pub type OnSessionEvent = Box<dyn Fn(&SessionEvent) + Send + Sync>;

/// Runs a Ralph loop session end-to-end
pub struct SessionRunner {
    config: SessionConfig,
    collector: TraceCollector,
    on_event: Option<OnSessionEvent>,
    cancel_token: CancellationToken,
}

impl SessionRunner {
    pub fn new(config: SessionConfig, collector: TraceCollector, cancel_token: CancellationToken) -> Self {
        Self {
            config,
            collector,
            on_event: None,
            cancel_token,
        }
    }

    pub fn on_event(mut self, cb: OnSessionEvent) -> Self {
        self.on_event = Some(cb);
        self
    }

    fn emit(&self, event: SessionEvent) {
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

                    if has_signal {
                        println!("[harness] Completion signal detected! Stopping loop.");
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

        let outcome = trace.outcome.clone();
        self.emit(SessionEvent::SessionComplete { outcome });

        let trace_path = self.collector.finalize(&mut trace, &[]).await?;
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
                                    ContentBlock::ToolUse { name, .. } => {
                                        println!("  [{iteration}] tool: {name}");
                                        self.emit(SessionEvent::ToolUse {
                                            iteration,
                                            tool_name: name.clone(),
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
                    process.abort_handle.abort();
                    anyhow::bail!("Session cancelled");
                }
            }
        }

        // Wait for process to exit
        let exit = process.completion.await??;

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
