use anyhow::Result;
use chrono::Utc;
use std::path::PathBuf;

use crate::output::ClaudeOutput;
use crate::runtime::RuntimeProvider;
use crate::trace::{self, SessionOutcome, SpanAttributes, TraceCollector};

/// Configuration for a Ralph loop session
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub repo_path: PathBuf,
    pub prompt: String,
    pub max_iterations: u32,
    pub completion_signal: String,
    pub extra_args: Vec<String>,
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
            extra_args: Vec::new(),
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

/// Callback for receiving iteration updates (Tauri IPC hookpoint)
pub type OnIterationComplete = Box<dyn Fn(u32, &ClaudeOutput) + Send + Sync>;

/// Runs a Ralph loop session end-to-end
pub struct SessionRunner {
    config: SessionConfig,
    collector: TraceCollector,
    on_iteration: Option<OnIterationComplete>,
}

impl SessionRunner {
    pub fn new(config: SessionConfig, collector: TraceCollector) -> Self {
        Self {
            config,
            collector,
            on_iteration: None,
        }
    }

    pub fn on_iteration_complete(mut self, cb: OnIterationComplete) -> Self {
        self.on_iteration = Some(cb);
        self
    }

    /// Execute the Ralph loop. Returns the finalized trace.
    pub async fn run(
        &self,
        runtime: &dyn RuntimeProvider,
    ) -> Result<trace::SessionTrace> {
        runtime.health_check().await?;

        let repo_str = self.config.repo_path.to_string_lossy().to_string();
        let mut trace = self.collector.start_session(&repo_str, &self.config.prompt);

        println!(
            "[harness] Starting Ralph loop on '{}' (max {} iterations)",
            repo_str, self.config.max_iterations
        );
        println!("[harness] Runtime: {}", runtime.name());
        println!(
            "[harness] Completion signal: {}",
            self.config.completion_signal
        );
        println!();

        let mut state = SessionState::Idle;

        for iteration in 1..=self.config.max_iterations {
            state = SessionState::Running { iteration };
            println!(
                "[harness] === Iteration {}/{} ===",
                iteration, self.config.max_iterations
            );

            let iter_start = Utc::now();

            let process_output = runtime
                .run_claude(
                    &self.config.prompt,
                    &self.config.repo_path,
                    &self.config.extra_args,
                )
                .await;

            let iter_end = Utc::now();

            match process_output {
                Ok(proc) => {
                    let claude_output = match ClaudeOutput::from_json(&proc.stdout) {
                        Ok(parsed) => parsed,
                        Err(e) => {
                            eprintln!(
                                "[harness] Failed to parse JSON output: {e}\n  stdout: {}",
                                &proc.stdout[..proc.stdout.len().min(200)]
                            );

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
                                    exit_code: proc.exit_code,
                                    result_preview: format!("JSON parse error: {e}"),
                                },
                                true,
                            );

                            state = SessionState::Failed {
                                iteration,
                                error: format!("JSON parse error: {e}"),
                            };
                            break;
                        }
                    };

                    let has_signal =
                        claude_output.has_completion_signal(&self.config.completion_signal);
                    let is_error = claude_output.is_error || proc.exit_code != 0;
                    let result_text = claude_output.result_text();

                    self.collector.record_iteration(
                        &mut trace,
                        iter_start,
                        iter_end,
                        SpanAttributes {
                            iteration,
                            claude_session_id: claude_output.session_id.clone(),
                            cost_usd: claude_output.total_cost_usd.unwrap_or(0.0),
                            num_turns: claude_output.num_turns,
                            api_duration_ms: claude_output.duration_api_ms,
                            completion_signal_found: has_signal,
                            exit_code: proc.exit_code,
                            result_preview: result_text[..result_text.len().min(500)].to_string(),
                        },
                        is_error,
                    );

                    if let Some(ref cb) = self.on_iteration {
                        cb(iteration, &claude_output);
                    }

                    println!(
                        "[harness] Iteration {iteration} complete: cost=${:.4}, turns={}, signal={}",
                        claude_output.total_cost_usd.unwrap_or(0.0),
                        claude_output.num_turns.unwrap_or(0),
                        has_signal,
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

                    if iteration < self.config.max_iterations {
                        tokio::time::sleep(tokio::time::Duration::from_millis(
                            self.config.inter_iteration_delay_ms,
                        ))
                        .await;
                    }
                }
                Err(e) => {
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

        let trace_path = self.collector.finalize(&mut trace).await?;
        println!("\n[harness] Trace saved to: {}", trace_path.display());

        trace::print_trace_summary(&trace);

        Ok(trace)
    }
}
