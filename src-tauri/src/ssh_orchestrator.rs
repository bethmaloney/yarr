use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::Result;
use chrono::Utc;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::output::{ContentBlock, StreamEvent};
use crate::runtime::ssh::{ssh_command, shell_escape, RemoteState, SshRuntime};
use crate::runtime::{ClaudeInvocation, RuntimeProvider, RunningProcess};
use crate::session::{OnSessionEvent, SessionConfig, SessionEvent, SessionState};
use crate::trace::{self, SessionOutcome, SpanAttributes, TraceCollector};

/// Truncate a string to at most `max_bytes` bytes without panicking on
/// multi-byte characters.  If the limit falls in the middle of a UTF-8
/// character, the slice is shortened to the previous character boundary.
fn truncate_str(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// Map a process exit to a human-readable disconnect reason.
fn classify_disconnect(exit: &crate::runtime::ProcessExit) -> String {
    // Exit code 255 is SSH-specific
    if exit.exit_code == 255 {
        let stderr = exit.stderr.trim();
        if stderr.contains("Connection refused") {
            "SSH connection refused — is the host running?".to_string()
        } else if stderr.contains("No route to host") {
            "Network unreachable — check your connection".to_string()
        } else if stderr.contains("Connection timed out") {
            "SSH connection timed out".to_string()
        } else {
            format!("SSH disconnected: {}", truncate_str(stderr, 200))
        }
    } else {
        format!("Remote process exited unexpectedly (code {})", exit.exit_code)
    }
}

/// Result of consuming events from a running process.
enum ConsumeResult {
    /// Got a Result event from Claude
    GotResult(crate::output::ResultEvent),
    /// Process exited without a Result event (disconnect)
    Disconnected(crate::runtime::ProcessExit),
    /// Cancelled via cancel token
    Cancelled,
}

/// What to do after processing a Result event.
enum IterationOutcome {
    /// Session completed (completion signal found)
    Completed,
    /// Session failed (error result)
    Failed(String),
    /// Continue to next iteration
    Continue,
}

/// Trait abstracting SSH runtime operations for testability.
#[async_trait::async_trait]
pub trait SshOps: Send + Sync {
    /// Human-readable name
    fn name(&self) -> &str;
    /// Check remote health (tmux + claude available)
    async fn health_check(&self) -> Result<()>;
    /// Set up remote log directory and create empty log file
    async fn init_session(&self, session_id: &str) -> Result<()>;
    /// Start a claude iteration in a tmux session.
    /// If append=true, appends to existing log file (tee -a).
    async fn start_iteration(
        &self,
        session_id: &str,
        invocation: &ClaudeInvocation,
        append: bool,
    ) -> Result<()>;
    /// Start tailing the log file from the given line number
    async fn start_tail(
        &self,
        session_id: &str,
        from_line: u64,
    ) -> Result<RunningProcess>;
    /// Check if remote tmux session is alive and if log has Result event
    async fn check_remote_state(&self, session_id: &str) -> Result<RemoteState>;
    /// Clean up remote log and stderr files
    async fn cleanup_remote(&self, session_id: &str) -> Result<()>;
    /// Get stderr output from remote
    async fn get_stderr(&self, session_id: &str) -> Result<String>;
}

#[allow(dead_code)]
pub struct SshSessionOrchestrator<S: SshOps> {
    ops: S,
    config: SessionConfig,
    collector: TraceCollector,
    cancel_token: CancellationToken,
    reconnect_notify: Arc<Notify>,
    on_event: Option<OnSessionEvent>,
    accumulated_events: std::sync::Mutex<Vec<SessionEvent>>,
    line_count: AtomicU64,
    trace_session_id: Option<String>,
}

#[allow(dead_code)]
impl<S: SshOps> SshSessionOrchestrator<S> {
    pub fn new(
        ops: S,
        config: SessionConfig,
        collector: TraceCollector,
        cancel_token: CancellationToken,
    ) -> Self {
        Self {
            ops,
            config,
            collector,
            cancel_token,
            reconnect_notify: Arc::new(Notify::new()),
            on_event: None,
            accumulated_events: std::sync::Mutex::new(Vec::new()),
            line_count: AtomicU64::new(1),
            trace_session_id: None,
        }
    }

    pub fn on_event(mut self, cb: OnSessionEvent) -> Self {
        self.on_event = Some(cb);
        self
    }

    pub fn with_trace_session_id(mut self, id: String) -> Self {
        self.trace_session_id = Some(id);
        self
    }

    /// Get a handle to signal reconnection from an external caller
    pub fn reconnect_notify(&self) -> Arc<Notify> {
        self.reconnect_notify.clone()
    }

    /// Get the current line count (for external inspection/testing)
    pub fn line_count(&self) -> u64 {
        self.line_count.load(Ordering::SeqCst)
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
            working_dir: self.config.effective_working_dir().to_path_buf(),
            model: self.config.model.clone(),
            extra_args: self.config.extra_args.clone(),
            env_vars: self.config.env_vars.clone(),
        }
    }

    /// Consume events from a running tail process.
    ///
    /// Loops over `process.events.recv()` with `tokio::select!` for
    /// cancellation, emitting session events and tracking the Result event.
    /// When the channel closes the process completion is awaited and the
    /// appropriate `ConsumeResult` variant is returned.
    async fn consume_events(
        &self,
        mut process: RunningProcess,
        iteration: u32,
    ) -> Result<ConsumeResult> {
        let mut result_event: Option<crate::output::ResultEvent> = None;

        loop {
            tokio::select! {
                event = process.events.recv() => {
                    let Some(event) = event else { break };
                    self.line_count.fetch_add(1, Ordering::SeqCst);
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
                                        self.emit(SessionEvent::ToolUse {
                                            iteration,
                                            tool_name: name.clone(),
                                            tool_input: Some(input.clone()),
                                        });
                                    }
                                    ContentBlock::Text { text } => {
                                        self.emit(SessionEvent::AssistantText {
                                            iteration,
                                            text: text.clone(),
                                        });
                                    }
                                    ContentBlock::Unknown => {}
                                }
                            }
                        }
                        StreamEvent::Result(r) => {
                            result_event = Some(r.clone());
                        }
                        StreamEvent::RateLimit(_) | StreamEvent::User(_) => {}
                    }
                }
                _ = self.cancel_token.cancelled() => {
                    process.abort_handle.abort();
                    return Ok(ConsumeResult::Cancelled);
                }
            }
        }

        // Channel closed — wait for the process to finish.
        let exit = process.completion.await??;

        match result_event {
            Some(r) => Ok(ConsumeResult::GotResult(r)),
            None => Ok(ConsumeResult::Disconnected(exit)),
        }
    }

    /// Process a Result event: record the iteration in the trace, emit
    /// events, and determine whether to continue, stop, or report failure.
    fn process_result(
        &self,
        result: &crate::output::ResultEvent,
        iteration: u32,
        iter_start: chrono::DateTime<chrono::Utc>,
        trace: &mut trace::SessionTrace,
    ) -> IterationOutcome {
        let iter_end = Utc::now();
        let has_signal = result.has_completion_signal(&self.config.completion_signal);
        let is_error = result.is_error;
        let result_text = result.result_text();

        self.collector.record_iteration(
            trace,
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
                result_preview: truncate_str(&result_text, 500).to_string(),
                token_usage: result.token_usage(),
                model_token_usage: result.model_token_usage(),
                // TODO: track last_context_tokens from assistant messages (like session.rs does)
                final_context_tokens: 0,
            },
            is_error,
        );

        self.emit(SessionEvent::IterationComplete {
            iteration,
            result: result.clone(),
        });

        if has_signal {
            IterationOutcome::Completed
        } else if is_error {
            IterationOutcome::Failed(result_text)
        } else {
            IterationOutcome::Continue
        }
    }

    /// Run the full session lifecycle. Long-running async method.
    /// Handles iterations, disconnect detection, and reconnection.
    pub async fn run(&self) -> Result<trace::SessionTrace> {
        // 1. Health check
        self.ops.health_check().await?;

        // 2. Generate session ID
        let session_id = uuid::Uuid::new_v4().to_string();

        // 3. Init session
        self.ops.init_session(&session_id).await?;

        // 4. (line_count starts at 1, tail will be started per iteration)

        // 5. Start trace
        let repo_str = self.config.repo_path.to_string_lossy().to_string();
        let mut trace = match &self.trace_session_id {
            Some(sid) => self.collector.start_session_with_id(sid, &repo_str, &self.config.prompt, self.config.plan_file.as_deref()),
            None => self.collector.start_session(&repo_str, &self.config.prompt, self.config.plan_file.as_deref()),
        };

        // 6. Emit SessionStarted
        self.emit(SessionEvent::SessionStarted {
            session_id: trace.session_id.clone(),
        });

        let mut state = SessionState::Idle;
        let invocation = self.build_invocation();

        // 7. Iteration loop
        for iteration in 1..=self.config.max_iterations {
            // a. Check cancellation
            if self.cancel_token.is_cancelled() {
                state = SessionState::Cancelled { iteration };
                break;
            }

            let append = iteration > 1;

            // b. Start iteration
            self.ops
                .start_iteration(&session_id, &invocation, append)
                .await?;

            // c. Emit IterationStarted
            self.emit(SessionEvent::IterationStarted { iteration });

            let iter_start = Utc::now();

            // d. Start tail and consume events
            let process = self
                .ops
                .start_tail(&session_id, self.line_count.load(Ordering::SeqCst))
                .await?;

            let consume_result = self.consume_events(process, iteration).await?;

            // Handle the consume result (may enter reconnect flow on disconnect)
            let result_for_processing = match consume_result {
                ConsumeResult::Cancelled => {
                    state = SessionState::Cancelled { iteration };
                    break;
                }
                ConsumeResult::GotResult(result) => Some(result),
                ConsumeResult::Disconnected(exit) => {
                    // No Result event -- disconnect detected
                    let reason = classify_disconnect(&exit);
                    self.emit(SessionEvent::Disconnected { iteration, reason: Some(reason) });

                    // Wait on reconnect_notify OR cancel_token
                    let reconnect_result: Option<crate::output::ResultEvent> = tokio::select! {
                        _ = self.reconnect_notify.notified() => {
                            self.emit(SessionEvent::Reconnecting { iteration });

                            let remote_state = self.ops.check_remote_state(&session_id).await?;

                            match remote_state {
                                RemoteState::Alive | RemoteState::CompletedOk => {
                                    let process = self
                                        .ops
                                        .start_tail(
                                            &session_id,
                                            self.line_count.load(Ordering::SeqCst),
                                        )
                                        .await?;

                                    match self.consume_events(process, iteration).await? {
                                        ConsumeResult::Cancelled => {
                                            state = SessionState::Cancelled { iteration };
                                            break;
                                        }
                                        ConsumeResult::GotResult(result) => Some(result),
                                        ConsumeResult::Disconnected(_exit) => {
                                            state = SessionState::Failed {
                                                iteration,
                                                error: "No result after reconnect".to_string(),
                                            };
                                            break;
                                        }
                                    }
                                }
                                RemoteState::Dead => {
                                    let stderr = self.ops.get_stderr(&session_id).await?;
                                    state = SessionState::Failed {
                                        iteration,
                                        error: format!(
                                            "Remote session died without completing. stderr: {}",
                                            stderr.trim()
                                        ),
                                    };
                                    break;
                                }
                            }
                        }
                        _ = self.cancel_token.cancelled() => {
                            state = SessionState::Cancelled { iteration };
                            break;
                        }
                    };

                    // If we broke out of the reconnect select with a terminal state, break the outer loop
                    match &state {
                        SessionState::Completed { .. }
                        | SessionState::Failed { .. }
                        | SessionState::Cancelled { .. } => break,
                        _ => {}
                    }

                    reconnect_result
                }
            };

            // e. Process the result if we have one
            if let Some(result) = result_for_processing {
                match self.process_result(&result, iteration, iter_start, &mut trace) {
                    IterationOutcome::Completed => {
                        state = SessionState::Completed {
                            iterations: iteration,
                        };
                        break;
                    }
                    IterationOutcome::Failed(error) => {
                        state = SessionState::Failed { iteration, error };
                        break;
                    }
                    IterationOutcome::Continue => {
                        // Inter-iteration delay
                        if iteration < self.config.max_iterations {
                            tokio::select! {
                                _ = tokio::time::sleep(tokio::time::Duration::from_millis(
                                    self.config.inter_iteration_delay_ms,
                                )) => {}
                                _ = self.cancel_token.cancelled() => {
                                    state = SessionState::Cancelled { iteration };
                                    break;
                                }
                            }
                        }
                        state = SessionState::Evaluating { iteration };
                    }
                }
            }
        }

        // 8. If loop exhausted without completion
        if matches!(state, SessionState::Evaluating { .. }) {
            state = SessionState::MaxIterations {
                iterations: self.config.max_iterations,
            };
        }

        // 9. Finalize trace
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
        self.collector.finalize(&mut trace, &events).await?;

        // 10. Cleanup (best-effort, ignore errors)
        let _ = self.ops.cleanup_remote(&session_id).await;

        // If the session failed due to dead remote, return error
        if trace.outcome == SessionOutcome::Failed {
            if let Some(ref reason) = trace.failure_reason {
                if reason.contains("Remote session died") {
                    anyhow::bail!("{}", reason);
                }
            }
        }

        // 11. Return trace
        Ok(trace)
    }
}

#[async_trait::async_trait]
impl SshOps for SshRuntime {
    fn name(&self) -> &str {
        "ssh"
    }

    async fn health_check(&self) -> Result<()> {
        RuntimeProvider::health_check(self).await
    }

    async fn init_session(&self, session_id: &str) -> Result<()> {
        let setup_cmd = format!(
            "mkdir -p ~/.yarr/logs && touch ~/.yarr/logs/yarr-{session_id}.log"
        );
        let output = ssh_command(&self.ssh_host, &setup_cmd).output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to init session: {}", stderr);
        }
        Ok(())
    }

    async fn start_iteration(
        &self,
        session_id: &str,
        invocation: &ClaudeInvocation,
        append: bool,
    ) -> Result<()> {
        let escaped_prompt = shell_escape(&invocation.prompt);
        let escaped_remote_path = shell_escape(&self.remote_path);

        let mut claude_cmd =
            String::from("claude -p --output-format stream-json --verbose");

        if let Some(ref model) = invocation.model {
            claude_cmd.push_str(&format!(" --model {}", shell_escape(model)));
        }

        for arg in &invocation.extra_args {
            claude_cmd.push_str(&format!(" {}", shell_escape(arg)));
        }

        claude_cmd.push_str(&format!(" {}", escaped_prompt));

        let tee_flag = if append { " -a" } else { "" };

        let tmux_body = format!(
            "cd {escaped_remote_path} && {claude_cmd} 2>/tmp/yarr-{session_id}.stderr | tee{tee_flag} ~/.yarr/logs/yarr-{session_id}.log"
        );

        let remote_cmd = format!(
            "tmux new-session -d -s yarr-{session_id} {escaped_body}",
            escaped_body = shell_escape(&tmux_body)
        );

        let output = ssh_command(&self.ssh_host, &remote_cmd).output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to start remote tmux session: {}", stderr);
        }
        Ok(())
    }

    async fn start_tail(
        &self,
        session_id: &str,
        from_line: u64,
    ) -> Result<RunningProcess> {
        self.resume_tail(session_id, from_line).await
    }

    async fn check_remote_state(&self, session_id: &str) -> Result<RemoteState> {
        SshRuntime::check_remote_state(self, session_id).await
    }

    async fn cleanup_remote(&self, session_id: &str) -> Result<()> {
        SshRuntime::cleanup_remote(self, session_id).await
    }

    async fn get_stderr(&self, session_id: &str) -> Result<String> {
        SshRuntime::get_stderr(self, session_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::{ResultEvent, StreamEvent};
    use crate::runtime::{ProcessExit, RunningProcess, TaskAbortHandle};
    use crate::trace::{SessionOutcome, TraceCollector};
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tempfile::TempDir;
    use tokio::sync::mpsc;

    struct MockSshOps {
        name: String,
        health_ok: bool,
        /// Each call to start_tail pops from this queue.
        /// Each entry is (events_to_send, exit_code).
        tail_scenarios: Mutex<VecDeque<(Vec<StreamEvent>, i32)>>,
        /// Each call to check_remote_state pops from this.
        remote_states: Mutex<VecDeque<RemoteState>>,
        /// stderr output to return
        stderr: Mutex<String>,
        // Call tracking
        init_called: AtomicBool,
        iterations_started: AtomicUsize,
        cleanups: AtomicUsize,
    }

    impl MockSshOps {
        fn new(name: &str) -> Self {
            Self {
                name: name.to_string(),
                health_ok: true,
                tail_scenarios: Mutex::new(VecDeque::new()),
                remote_states: Mutex::new(VecDeque::new()),
                stderr: Mutex::new(String::new()),
                init_called: AtomicBool::new(false),
                iterations_started: AtomicUsize::new(0),
                cleanups: AtomicUsize::new(0),
            }
        }

        fn with_health_ok(mut self, ok: bool) -> Self {
            self.health_ok = ok;
            self
        }

        fn push_tail_scenario(self, events: Vec<StreamEvent>, exit_code: i32) -> Self {
            self.tail_scenarios
                .lock()
                .unwrap()
                .push_back((events, exit_code));
            self
        }

        fn push_remote_state(self, state: RemoteState) -> Self {
            self.remote_states.lock().unwrap().push_back(state);
            self
        }

        #[allow(dead_code)]
        fn with_stderr(self, stderr: &str) -> Self {
            *self.stderr.lock().unwrap() = stderr.to_string();
            self
        }
    }

    #[async_trait::async_trait]
    impl SshOps for MockSshOps {
        fn name(&self) -> &str {
            &self.name
        }

        async fn health_check(&self) -> Result<()> {
            if self.health_ok {
                Ok(())
            } else {
                anyhow::bail!("Health check failed: mock is configured to fail")
            }
        }

        async fn init_session(&self, _session_id: &str) -> Result<()> {
            self.init_called.store(true, Ordering::SeqCst);
            Ok(())
        }

        async fn start_iteration(
            &self,
            _session_id: &str,
            _invocation: &ClaudeInvocation,
            _append: bool,
        ) -> Result<()> {
            self.iterations_started.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn start_tail(
            &self,
            _session_id: &str,
            _from_line: u64,
        ) -> Result<RunningProcess> {
            let (events, exit_code) = self
                .tail_scenarios
                .lock()
                .unwrap()
                .pop_front()
                .expect("MockSshOps: no tail scenario available");

            let (tx, rx) = mpsc::channel::<StreamEvent>(64);

            let completion = tokio::spawn(async move {
                // Emit events with small delays to simulate streaming
                for event in events {
                    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
                // Small delay then drop sender
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                drop(tx);
                Ok(ProcessExit {
                    exit_code,
                    wall_time_ms: 100,
                    stderr: String::new(),
                })
            });

            let abort_handle = TaskAbortHandle(completion.abort_handle());
            Ok(RunningProcess {
                events: rx,
                completion,
                abort_handle: Box::new(abort_handle),
            })
        }

        async fn check_remote_state(&self, _session_id: &str) -> Result<RemoteState> {
            let state = self
                .remote_states
                .lock()
                .unwrap()
                .pop_front()
                .expect("MockSshOps: no remote state available");
            Ok(state)
        }

        async fn cleanup_remote(&self, _session_id: &str) -> Result<()> {
            self.cleanups.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn get_stderr(&self, _session_id: &str) -> Result<String> {
            Ok(self.stderr.lock().unwrap().clone())
        }
    }

    // ── Helper functions ──────────────────────────────────────────

    fn make_config() -> SessionConfig {
        SessionConfig {
            repo_path: std::path::PathBuf::from("/mock/project"),
            working_dir: None,
            prompt: "Test prompt".to_string(),
            max_iterations: 5,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            model: None,
            extra_args: vec![],
            plan_file: None,
            inter_iteration_delay_ms: 0,
            env_vars: std::collections::HashMap::new(),
            checks: Vec::new(),
            git_sync: None,
        }
    }

    fn make_collector(tmp: &TempDir) -> TraceCollector {
        TraceCollector::new(tmp.path(), "test-repo")
    }

    /// Build a Result event that contains the completion signal.
    fn make_completing_result() -> StreamEvent {
        StreamEvent::Result(ResultEvent {
            subtype: Some("success".to_string()),
            is_error: false,
            duration_ms: Some(1000),
            duration_api_ms: Some(900),
            num_turns: Some(1),
            result: Some("Done. <promise>COMPLETE</promise>".to_string()),
            session_id: Some("test-session".to_string()),
            total_cost_usd: Some(0.01),
            stop_reason: Some("end_turn".to_string()),
            usage: None,
            model_usage: None,
        })
    }

    /// Build a Result event that does NOT contain the completion signal.
    fn make_non_completing_result() -> StreamEvent {
        StreamEvent::Result(ResultEvent {
            subtype: Some("success".to_string()),
            is_error: false,
            duration_ms: Some(1000),
            duration_api_ms: Some(900),
            num_turns: Some(1),
            result: Some("Working on it...".to_string()),
            session_id: Some("test-session".to_string()),
            total_cost_usd: Some(0.01),
            stop_reason: Some("end_turn".to_string()),
            usage: None,
            model_usage: None,
        })
    }

    /// Build a system init event
    fn make_system_event() -> StreamEvent {
        StreamEvent::System(crate::output::SystemEvent {
            subtype: Some("init".to_string()),
            session_id: Some("test-session".to_string()),
            cwd: Some("/mock/project".to_string()),
            model: Some("mock-model".to_string()),
            tools: Some(vec!["Read".to_string(), "Write".to_string()]),
        })
    }

    /// Build an assistant text event
    fn make_assistant_text(text: &str) -> StreamEvent {
        StreamEvent::Assistant(crate::output::AssistantEvent {
            message: crate::output::AssistantMessage {
                id: Some("msg_1".to_string()),
                role: Some("assistant".to_string()),
                model: Some("mock-model".to_string()),
                content: vec![crate::output::ContentBlock::Text {
                    text: text.to_string(),
                }],
                stop_reason: Some("end_turn".to_string()),
                usage: None,
            },
            session_id: Some("test-session".to_string()),
        })
    }

    /// Build a standard set of events for one successful iteration ending with completion.
    fn make_completing_events() -> Vec<StreamEvent> {
        vec![
            make_system_event(),
            make_assistant_text("Working..."),
            make_completing_result(),
        ]
    }

    /// Build a standard set of events for one iteration that does NOT complete.
    fn make_non_completing_events() -> Vec<StreamEvent> {
        vec![
            make_system_event(),
            make_assistant_text("Still working..."),
            make_non_completing_result(),
        ]
    }

    // ── Tests ─────────────────────────────────────────────────────

    #[tokio::test]
    async fn test_single_iteration_completion() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(make_completing_events(), 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let trace = orchestrator.run().await.expect("run should succeed");

        assert_eq!(trace.outcome, SessionOutcome::Completed);
        assert_eq!(trace.total_iterations, 1);
    }

    #[tokio::test]
    async fn test_multi_iteration_completion() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(make_non_completing_events(), 0)
            .push_tail_scenario(make_completing_events(), 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let trace = orchestrator.run().await.expect("run should succeed");

        assert_eq!(trace.outcome, SessionOutcome::Completed);
        assert_eq!(trace.total_iterations, 2);
    }

    #[tokio::test]
    async fn test_max_iterations_reached() {
        let tmp = TempDir::new().expect("create temp dir");
        let mut config = make_config();
        config.max_iterations = 3;
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(make_non_completing_events(), 0)
            .push_tail_scenario(make_non_completing_events(), 0)
            .push_tail_scenario(make_non_completing_events(), 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let trace = orchestrator.run().await.expect("run should succeed");

        assert_eq!(trace.outcome, SessionOutcome::MaxIterationsReached);
        assert_eq!(trace.total_iterations, 3);
    }

    #[tokio::test]
    async fn test_disconnect_detected() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // Tail exits with code 255 (SSH disconnect), no Result event
        let disconnect_events = vec![
            make_system_event(),
            make_assistant_text("Partial work..."),
            // No Result event — tail dies from SSH disconnect
        ];

        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(disconnect_events, 255);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token.clone());

        // Collect emitted events to verify Disconnected was emitted
        let events = Arc::new(std::sync::Mutex::new(Vec::<SessionEvent>::new()));
        let events_clone = events.clone();
        let orchestrator = orchestrator.on_event(Box::new(move |event| {
            events_clone.lock().unwrap().push(event.clone());
        }));

        // Cancel after a short delay so we don't hang waiting for reconnect
        let cancel = cancel_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            cancel.cancel();
        });

        let _result = orchestrator.run().await;

        // Verify a Disconnected event was emitted
        let emitted = events.lock().unwrap();
        let has_disconnect = emitted
            .iter()
            .any(|e| matches!(e, SessionEvent::Disconnected { .. }));
        assert!(
            has_disconnect,
            "Expected a Disconnected event to be emitted, got: {:?}",
            *emitted
        );
    }

    #[tokio::test]
    async fn test_reconnect_alive_resumes() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // First tail disconnects (no Result, exit 255)
        let disconnect_events = vec![
            make_system_event(),
            make_assistant_text("Before disconnect..."),
        ];

        // Second tail (after reconnect) completes
        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(disconnect_events, 255)
            .push_remote_state(RemoteState::Alive)
            .push_tail_scenario(make_completing_events(), 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let reconnect = orchestrator.reconnect_notify();

        // Signal reconnect after a short delay
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            reconnect.notify_one();
        });

        let trace = orchestrator.run().await.expect("run should succeed");

        assert_eq!(trace.outcome, SessionOutcome::Completed);
    }

    #[tokio::test]
    async fn test_reconnect_completed() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // First tail disconnects
        let disconnect_events = vec![
            make_system_event(),
            make_assistant_text("Before disconnect..."),
        ];

        // Remote state: CompletedOk (tmux dead, Result found in log)
        // Second tail picks up the remaining events including Result
        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(disconnect_events, 255)
            .push_remote_state(RemoteState::CompletedOk)
            .push_tail_scenario(make_completing_events(), 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let reconnect = orchestrator.reconnect_notify();

        // Signal reconnect after a short delay
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            reconnect.notify_one();
        });

        let trace = orchestrator.run().await.expect("run should succeed");

        assert_eq!(trace.outcome, SessionOutcome::Completed);
    }

    #[tokio::test]
    async fn test_reconnect_dead_fails() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // First tail disconnects
        let disconnect_events = vec![
            make_system_event(),
            make_assistant_text("Before disconnect..."),
        ];

        // Remote state: Dead (tmux dead, no Result in log)
        let mock = MockSshOps::new("test-ssh")
            .push_tail_scenario(disconnect_events, 255)
            .push_remote_state(RemoteState::Dead);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let reconnect = orchestrator.reconnect_notify();

        // Signal reconnect after a short delay
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            reconnect.notify_one();
        });

        let result = orchestrator.run().await;

        assert!(
            result.is_err(),
            "Expected error when remote session is dead, got: {:?}",
            result
        );
    }

    #[tokio::test]
    async fn test_line_count_increments() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // 3 events: system + assistant text + result
        let events = make_completing_events();
        let num_events = events.len() as u64;

        let mock = MockSshOps::new("test-ssh").push_tail_scenario(events, 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let _trace = orchestrator.run().await.expect("run should succeed");

        // After processing N events, line_count should be N+1 (next line to read)
        assert_eq!(
            orchestrator.line_count(),
            num_events + 1,
            "line_count should be N+1 after processing N events"
        );
    }

    #[tokio::test]
    async fn test_cancellation_stops_session() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        // Create a long-running tail scenario (many events)
        let mut events = Vec::new();
        events.push(make_system_event());
        for i in 0..50 {
            events.push(make_assistant_text(&format!("Working on step {i}...")));
        }
        // No Result event — it would keep going

        let mock = MockSshOps::new("test-ssh").push_tail_scenario(events, 0);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token.clone());

        // Cancel after a short delay
        let cancel = cancel_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
            cancel.cancel();
        });

        let trace = orchestrator.run().await.expect("run should succeed even when cancelled");

        assert_eq!(trace.outcome, SessionOutcome::Cancelled);
    }

    #[tokio::test]
    async fn test_health_check_failure() {
        let tmp = TempDir::new().expect("create temp dir");
        let config = make_config();
        let collector = make_collector(&tmp);
        let cancel_token = CancellationToken::new();

        let mock = MockSshOps::new("test-ssh").with_health_ok(false);

        let orchestrator = SshSessionOrchestrator::new(mock, config, collector, cancel_token);
        let result = orchestrator.run().await;

        assert!(
            result.is_err(),
            "Expected error when health check fails, got: {:?}",
            result
        );
    }

    // ── classify_disconnect tests ────────────────────────────────

    #[test]
    fn test_classify_disconnect_connection_refused() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 50,
            stderr: "ssh: connect to host example.com port 22: Connection refused".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "SSH connection refused — is the host running?"
        );
    }

    #[test]
    fn test_classify_disconnect_no_route_to_host() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 3000,
            stderr: "ssh: connect to host 10.0.0.5 port 22: No route to host".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "Network unreachable — check your connection"
        );
    }

    #[test]
    fn test_classify_disconnect_connection_timed_out() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 30000,
            stderr: "ssh: connect to host example.com port 22: Connection timed out".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(reason, "SSH connection timed out");
    }

    #[test]
    fn test_classify_disconnect_exit_255_other_stderr() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 100,
            stderr: "Permission denied (publickey).".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "SSH disconnected: Permission denied (publickey)."
        );
    }

    #[test]
    fn test_classify_disconnect_non_255_exit_code() {
        let exit = ProcessExit {
            exit_code: 1,
            wall_time_ms: 500,
            stderr: "some error output".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "Remote process exited unexpectedly (code 1)"
        );
    }

    #[test]
    fn test_classify_disconnect_exit_255_empty_stderr() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 100,
            stderr: String::new(),
        };
        let reason = classify_disconnect(&exit);
        // With empty stderr it should fall through to the generic 255 branch
        assert_eq!(reason, "SSH disconnected: ");
    }

    #[test]
    fn test_classify_disconnect_exit_255_stderr_trimmed() {
        let exit = ProcessExit {
            exit_code: 255,
            wall_time_ms: 100,
            stderr: "  Host key verification failed.  \n".to_string(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "SSH disconnected: Host key verification failed."
        );
    }

    #[test]
    fn test_classify_disconnect_exit_code_137_sigkill() {
        let exit = ProcessExit {
            exit_code: 137,
            wall_time_ms: 200,
            stderr: String::new(),
        };
        let reason = classify_disconnect(&exit);
        assert_eq!(
            reason,
            "Remote process exited unexpectedly (code 137)"
        );
    }
}
