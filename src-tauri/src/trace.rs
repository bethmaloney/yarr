use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use tracing::warn;
use uuid::Uuid;

use crate::output::{ModelTokenUsage, TokenUsage};

/// A single span representing one Ralph iteration
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct IterationSpan {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: String,
    pub operation_name: String,
    pub start_time: DateTime<Utc>,
    pub end_time: DateTime<Utc>,
    pub duration_ms: u64,
    pub status: SpanStatus,
    pub attributes: SpanAttributes,
}

/// The top-level trace for an entire Ralph loop session
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SessionTrace {
    pub trace_id: String,
    pub root_span_id: String,
    pub session_id: String,
    pub repo_path: String,
    pub prompt: String,
    #[serde(default)]
    pub plan_file: Option<String>,
    #[serde(default)]
    pub repo_id: Option<String>,
    #[serde(default = "default_session_type")]
    pub session_type: String,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub outcome: SessionOutcome,
    #[serde(default)]
    pub failure_reason: Option<String>,
    pub iterations: Vec<IterationSpan>,
    pub total_cost_usd: f64,
    pub total_iterations: u32,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_cache_read_tokens: u64,
    pub total_cache_creation_tokens: u64,
    #[serde(default)]
    pub context_window: u64,
    #[serde(default)]
    pub final_context_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SpanAttributes {
    pub iteration: u32,
    pub claude_session_id: Option<String>,
    pub cost_usd: f64,
    pub num_turns: Option<u32>,
    pub api_duration_ms: Option<u64>,
    pub completion_signal_found: bool,
    pub exit_code: i32,
    pub result_preview: String,
    pub token_usage: TokenUsage,
    pub model_token_usage: HashMap<String, ModelTokenUsage>,
    #[serde(default)]
    pub final_context_tokens: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SpanStatus {
    Ok,
    Error,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SessionOutcome {
    Running,
    Completed,
    MaxIterationsReached,
    Failed,
    Cancelled,
}

/// Collects spans and writes them to disk as OTLP-compatible JSON
#[derive(Clone)]
pub struct TraceCollector {
    output_dir: PathBuf,
    repo_id: String,
}

fn default_session_type() -> String {
    "ralph_loop".to_string()
}

/// Validate that a path component does not contain traversal characters.
fn validate_path_component(value: &str, name: &str) -> anyhow::Result<()> {
    if value.is_empty() || value.contains('/') || value.contains('\\') || value.contains("..") {
        anyhow::bail!("Invalid {name}: contains path traversal characters");
    }
    Ok(())
}

impl TraceCollector {
    pub fn new(base_dir: impl Into<PathBuf>, repo_id: &str) -> Self {
        validate_path_component(repo_id, "repo_id")
            .expect("repo_id must not contain path traversal characters");
        Self {
            output_dir: base_dir.into().join("traces").join(repo_id),
            repo_id: repo_id.to_string(),
        }
    }

    /// Create a new session trace with a pre-generated session_id
    pub fn start_session_with_id(&self, session_id: &str, repo_path: &str, prompt: &str, plan_file: Option<&str>) -> SessionTrace {
        let trace_id = Uuid::new_v4().to_string().replace('-', "");
        let root_span_id = Uuid::new_v4().to_string().replace('-', "")[..16].to_string();
        SessionTrace {
            trace_id,
            root_span_id,
            session_id: session_id.to_string(),
            repo_path: repo_path.to_string(),
            prompt: prompt.to_string(),
            plan_file: plan_file.map(|s| s.to_string()),
            repo_id: Some(self.repo_id.clone()),
            session_type: "ralph_loop".to_string(),
            start_time: Utc::now(),
            end_time: None,
            outcome: SessionOutcome::Running,
            failure_reason: None,
            iterations: Vec::new(),
            total_cost_usd: 0.0,
            total_iterations: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_creation_tokens: 0,
            context_window: 0,
            final_context_tokens: 0,
        }
    }

    /// Create a new session trace (call at loop start)
    pub fn start_session(&self, repo_path: &str, prompt: &str, plan_file: Option<&str>) -> SessionTrace {
        let trace_id = Uuid::new_v4().to_string().replace('-', "");
        let root_span_id = Uuid::new_v4().to_string().replace('-', "")[..16].to_string();

        SessionTrace {
            trace_id,
            root_span_id,
            session_id: Uuid::new_v4().to_string(),
            repo_path: repo_path.to_string(),
            prompt: prompt.to_string(),
            plan_file: plan_file.map(|s| s.to_string()),
            repo_id: Some(self.repo_id.clone()),
            session_type: "ralph_loop".to_string(),
            start_time: Utc::now(),
            end_time: None,
            outcome: SessionOutcome::Running,
            failure_reason: None,
            iterations: Vec::new(),
            total_cost_usd: 0.0,
            total_iterations: 0,
            total_input_tokens: 0,
            total_output_tokens: 0,
            total_cache_read_tokens: 0,
            total_cache_creation_tokens: 0,
            context_window: 0,
            final_context_tokens: 0,
        }
    }

    /// Record a completed iteration span
    pub fn record_iteration(
        &self,
        trace: &mut SessionTrace,
        start_time: DateTime<Utc>,
        end_time: DateTime<Utc>,
        attrs: SpanAttributes,
        is_error: bool,
    ) {
        let span_id = Uuid::new_v4().to_string().replace('-', "")[..16].to_string();

        let span = IterationSpan {
            trace_id: trace.trace_id.clone(),
            span_id,
            parent_span_id: trace.root_span_id.clone(),
            operation_name: format!("ralph.iteration.{}", attrs.iteration),
            start_time,
            end_time,
            duration_ms: (end_time - start_time).num_milliseconds().max(0) as u64,
            status: if is_error { SpanStatus::Error } else { SpanStatus::Ok },
            attributes: attrs,
        };

        trace.total_cost_usd += span.attributes.cost_usd;
        trace.total_input_tokens += span.attributes.token_usage.input_tokens;
        trace.total_output_tokens += span.attributes.token_usage.output_tokens;
        trace.total_cache_read_tokens += span.attributes.token_usage.cache_read_input_tokens;
        trace.total_cache_creation_tokens += span.attributes.token_usage.cache_creation_input_tokens;
        trace.total_iterations += 1;

        // Context fields: always overwrite with latest iteration (last call wins)
        trace.final_context_tokens = span.attributes.final_context_tokens;
        trace.context_window = span.attributes.model_token_usage
            .values()
            .map(|m| m.context_window)
            .max()
            .unwrap_or(0);

        trace.iterations.push(span);
    }

    /// Finalize and persist the session trace to disk
    pub async fn finalize(
        &self,
        trace: &mut SessionTrace,
        _events: &[crate::session::SessionEvent],
    ) -> anyhow::Result<PathBuf> {
        trace.end_time = Some(Utc::now());

        trace.total_cost_usd = trace
            .iterations
            .iter()
            .map(|s| s.attributes.cost_usd)
            .sum();
        trace.total_input_tokens = trace
            .iterations
            .iter()
            .map(|s| s.attributes.token_usage.input_tokens)
            .sum();
        trace.total_output_tokens = trace
            .iterations
            .iter()
            .map(|s| s.attributes.token_usage.output_tokens)
            .sum();
        trace.total_cache_read_tokens = trace
            .iterations
            .iter()
            .map(|s| s.attributes.token_usage.cache_read_input_tokens)
            .sum();
        trace.total_cache_creation_tokens = trace
            .iterations
            .iter()
            .map(|s| s.attributes.token_usage.cache_creation_input_tokens)
            .sum();

        // Context fields: use last iteration's values
        if let Some(last) = trace.iterations.last() {
            trace.final_context_tokens = last.attributes.final_context_tokens;
            trace.context_window = last.attributes.model_token_usage
                .values()
                .map(|m| m.context_window)
                .max()
                .unwrap_or(0);
        }

        tokio::fs::create_dir_all(&self.output_dir).await?;

        let trace_filename = format!("trace_{}.json", trace.session_id);
        let trace_path = self.output_dir.join(&trace_filename);

        let json = serde_json::to_string_pretty(trace)?;
        tokio::fs::write(&trace_path, json).await?;

        Ok(trace_path)
    }

    /// List traces. If repo_id is Some, read from base_dir/traces/{repo_id}/.
    /// If None, read across all repo subdirs under base_dir/traces/.
    /// Returns sorted by start_time descending.
    pub fn list_traces(base_dir: &Path, repo_id: Option<&str>) -> anyhow::Result<Vec<SessionTrace>> {
        let traces_dir = base_dir.join("traces");

        let dirs_to_scan: Vec<PathBuf> = if let Some(id) = repo_id {
            validate_path_component(id, "repo_id")?;
            let dir = traces_dir.join(id);
            if dir.exists() {
                vec![dir]
            } else {
                return Ok(vec![]);
            }
        } else {
            if !traces_dir.exists() {
                return Ok(vec![]);
            }
            let mut dirs = Vec::new();
            for entry in std::fs::read_dir(&traces_dir)? {
                let entry = entry?;
                if entry.file_type()?.is_dir() {
                    dirs.push(entry.path());
                }
            }
            dirs
        };

        let mut traces = Vec::new();
        for dir in dirs_to_scan {
            if !dir.exists() {
                continue;
            }
            // Extract directory name to use as fallback repo_id for old traces
            let dir_name = dir
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            for entry in std::fs::read_dir(&dir)? {
                let entry = entry?;
                let path = entry.path();
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with("trace_") && name.ends_with(".json") {
                        let contents = match std::fs::read_to_string(&path) {
                            Ok(c) => c,
                            Err(e) => {
                                warn!("Skipping unreadable trace file {:?}: {}", path, e);
                                continue;
                            }
                        };
                        match serde_json::from_str::<SessionTrace>(&contents) {
                            Ok(mut trace) => {
                                // Backfill repo_id from directory name for old-format traces
                                if trace.repo_id.is_none() {
                                    trace.repo_id = dir_name.clone();
                                }
                                traces.push(trace);
                            }
                            Err(e) => {
                                warn!("Skipping malformed trace file {:?}: {}", path, e);
                            }
                        }
                    }
                }
            }
        }

        traces.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        Ok(traces)
    }

    /// List only the most recent trace per repo, sorted by start_time descending.
    pub fn list_latest_traces(base_dir: &Path) -> anyhow::Result<Vec<SessionTrace>> {
        let all_traces = Self::list_traces(base_dir, None)?;
        let mut latest_by_repo: HashMap<String, SessionTrace> = HashMap::new();
        for trace in all_traces {
            if let Some(ref repo_id) = trace.repo_id {
                latest_by_repo
                    .entry(repo_id.clone())
                    .and_modify(|existing| {
                        if trace.start_time > existing.start_time {
                            *existing = trace.clone();
                        }
                    })
                    .or_insert(trace);
            }
        }
        let mut results: Vec<SessionTrace> = latest_by_repo.into_values().collect();
        results.sort_by(|a, b| b.start_time.cmp(&a.start_time));
        Ok(results)
    }

    /// Read a single trace file
    pub fn read_trace(base_dir: &Path, repo_id: &str, session_id: &str) -> anyhow::Result<SessionTrace> {
        validate_path_component(repo_id, "repo_id")?;
        validate_path_component(session_id, "session_id")?;
        let path = base_dir
            .join("traces")
            .join(repo_id)
            .join(format!("trace_{}.json", session_id));
        let contents = std::fs::read_to_string(&path)?;
        let trace: SessionTrace = serde_json::from_str(&contents)?;
        Ok(trace)
    }

    /// Read the events file for a session
    pub fn read_events(base_dir: &Path, repo_id: &str, session_id: &str) -> anyhow::Result<Vec<crate::session::SessionEvent>> {
        validate_path_component(repo_id, "repo_id")?;
        validate_path_component(session_id, "session_id")?;
        let path = base_dir
            .join("traces")
            .join(repo_id)
            .join(format!("events_{}.jsonl", session_id));
        let contents = std::fs::read_to_string(&path)?;
        let mut events = Vec::new();
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<crate::session::SessionEvent>(line) {
                Ok(event) => events.push(event),
                Err(e) => {
                    warn!("Skipping malformed event line in {:?}: {}", path, e);
                }
            }
        }
        Ok(events)
    }

    /// Append a single event as a JSONL line to the events file
    pub fn append_event(&self, session_id: &str, event: &crate::session::SessionEvent) -> anyhow::Result<()> {
        validate_path_component(session_id, "session_id")?;
        std::fs::create_dir_all(&self.output_dir)?;
        let path = self.output_dir.join(format!("events_{}.jsonl", session_id));
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        writeln!(file, "{}", serde_json::to_string(event)?)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::output::ResultEvent;
    use crate::session::SessionEvent;

    /// Helper to build a minimal SessionTrace for testing
    fn make_test_trace(plan_file: Option<String>) -> SessionTrace {
        SessionTrace {
            trace_id: "abc123".to_string(),
            root_span_id: "span456".to_string(),
            session_id: "sess-789".to_string(),
            repo_path: "/tmp/repo".to_string(),
            prompt: "do the thing".to_string(),
            plan_file,
            repo_id: Some("test-repo".to_string()),
            session_type: "ralph_loop".to_string(),
            start_time: Utc::now(),
            end_time: Some(Utc::now()),
            outcome: SessionOutcome::Completed,
            failure_reason: None,
            iterations: vec![],
            total_cost_usd: 1.23,
            total_iterations: 2,
            total_input_tokens: 100,
            total_output_tokens: 50,
            total_cache_read_tokens: 10,
            total_cache_creation_tokens: 5,
            context_window: 0,
            final_context_tokens: 0,
        }
    }

    /// Helper to build a minimal ResultEvent for testing
    fn make_test_result_event() -> ResultEvent {
        ResultEvent {
            subtype: Some("success".to_string()),
            is_error: false,
            duration_ms: Some(1500),
            duration_api_ms: Some(1400),
            num_turns: Some(3),
            result: Some("All done.".to_string()),
            session_id: Some("sess-789".to_string()),
            total_cost_usd: Some(0.05),
            stop_reason: Some("end_turn".to_string()),
            usage: None,
            model_usage: None,
        }
    }

    // ── Test 1: SessionTrace serde round-trip with plan_file Some ──

    #[test]
    fn session_trace_round_trip_with_plan_file() {
        let trace = make_test_trace(Some("plan.md".to_string()));

        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");
        let restored: SessionTrace =
            serde_json::from_str(&json).expect("deserialize SessionTrace");

        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.root_span_id, trace.root_span_id);
        assert_eq!(restored.session_id, trace.session_id);
        assert_eq!(restored.repo_path, trace.repo_path);
        assert_eq!(restored.prompt, trace.prompt);
        assert_eq!(restored.plan_file, Some("plan.md".to_string()));
        assert_eq!(restored.outcome, trace.outcome);
        assert_eq!(restored.total_cost_usd, trace.total_cost_usd);
        assert_eq!(restored.total_iterations, trace.total_iterations);
        assert_eq!(restored.total_input_tokens, trace.total_input_tokens);
        assert_eq!(restored.total_output_tokens, trace.total_output_tokens);
        assert_eq!(
            restored.total_cache_read_tokens,
            trace.total_cache_read_tokens
        );
        assert_eq!(
            restored.total_cache_creation_tokens,
            trace.total_cache_creation_tokens
        );
        assert_eq!(restored.iterations.len(), 0);
    }

    // ── Test 2: SessionTrace round-trip with plan_file None ──

    #[test]
    fn session_trace_round_trip_with_plan_file_none() {
        let trace = make_test_trace(None);

        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");
        let restored: SessionTrace =
            serde_json::from_str(&json).expect("deserialize SessionTrace");

        assert_eq!(restored.plan_file, None);
        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.prompt, trace.prompt);
    }

    // ── Test 3: SessionOutcome serde round-trip for each variant ──

    #[test]
    fn session_outcome_round_trip() {
        let variants = vec![
            SessionOutcome::Running,
            SessionOutcome::Completed,
            SessionOutcome::MaxIterationsReached,
            SessionOutcome::Failed,
            SessionOutcome::Cancelled,
        ];

        for variant in variants {
            let json = serde_json::to_string(&variant).expect("serialize SessionOutcome");
            let restored: SessionOutcome =
                serde_json::from_str(&json).expect("deserialize SessionOutcome");
            assert_eq!(restored, variant);
        }
    }

    // ── Test 4: SessionEvent::SessionStarted serde round-trip ──

    #[test]
    fn session_event_started_round_trip() {
        let event = SessionEvent::SessionStarted {
            session_id: "sess-abc".to_string(),
        };

        let json = serde_json::to_string(&event).expect("serialize SessionEvent");
        let restored: SessionEvent =
            serde_json::from_str(&json).expect("deserialize SessionEvent");

        match restored {
            SessionEvent::SessionStarted { session_id } => {
                assert_eq!(session_id, "sess-abc");
            }
            _ => panic!("expected SessionStarted variant"),
        }
    }

    // ── Test 5: SessionEvent::IterationComplete round-trip ──

    #[test]
    fn session_event_iteration_complete_round_trip() {
        let result = make_test_result_event();
        let event = SessionEvent::IterationComplete {
            iteration: 3,
            result: result.clone(),
        };

        let json = serde_json::to_string(&event).expect("serialize SessionEvent");
        let restored: SessionEvent =
            serde_json::from_str(&json).expect("deserialize SessionEvent");

        match restored {
            SessionEvent::IterationComplete { iteration, result } => {
                assert_eq!(iteration, 3);
                assert_eq!(result.subtype.as_deref(), Some("success"));
                assert!(!result.is_error);
                assert_eq!(result.duration_ms, Some(1500));
                assert_eq!(result.num_turns, Some(3));
                assert_eq!(result.result.as_deref(), Some("All done."));
                assert_eq!(result.session_id.as_deref(), Some("sess-789"));
                assert_eq!(result.total_cost_usd, Some(0.05));
                assert_eq!(result.stop_reason.as_deref(), Some("end_turn"));
            }
            _ => panic!("expected IterationComplete variant"),
        }
    }

    // ── Test 6: start_session with plan_file Some ──

    #[test]
    fn start_session_sets_plan_file() {
        let collector = TraceCollector::new("/tmp", "traces");
        let trace = collector.start_session("/tmp/repo", "do stuff", Some("plan.md"));

        assert_eq!(trace.plan_file, Some("plan.md".to_string()));
        assert_eq!(trace.repo_id, Some("traces".to_string()));
        assert_eq!(trace.repo_path, "/tmp/repo");
        assert_eq!(trace.prompt, "do stuff");
        assert_eq!(trace.outcome, SessionOutcome::Running);
    }

    // ── Test 7: start_session with plan_file None ──

    #[test]
    fn start_session_without_plan_file() {
        let collector = TraceCollector::new("/tmp", "traces");
        let trace = collector.start_session("/tmp/repo", "do stuff", None);

        assert_eq!(trace.plan_file, None);
        assert_eq!(trace.repo_path, "/tmp/repo");
        assert_eq!(trace.prompt, "do stuff");
    }

    // ── Test 8: Backward compat — old trace JSON without plan_file key ──

    #[test]
    fn session_trace_backward_compat_without_plan_file() {
        // Build a trace, serialize it, then strip the plan_file and repo_id keys to simulate an old-format file
        let trace = make_test_trace(None);
        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");

        // Parse into a generic Value, remove plan_file and repo_id, and re-serialize
        let mut value: serde_json::Value =
            serde_json::from_str(&json).expect("parse as Value");
        let obj = value.as_object_mut().expect("top-level object");
        assert!(obj.remove("plan_file").is_some(), "plan_file key should have been present");
        assert!(obj.remove("repo_id").is_some(), "repo_id key should have been present");

        let old_format_json = serde_json::to_string(&value).expect("re-serialize without plan_file/repo_id");

        // Deserialize the old-format JSON — this would fail without #[serde(default)]
        let restored: SessionTrace =
            serde_json::from_str(&old_format_json).expect("deserialize old-format trace");

        assert_eq!(restored.plan_file, None);
        assert_eq!(restored.repo_id, None);
        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.session_id, trace.session_id);
        assert_eq!(restored.repo_path, trace.repo_path);
        assert_eq!(restored.prompt, trace.prompt);
        assert_eq!(restored.total_cost_usd, trace.total_cost_usd);
    }

    // ══════════════════════════════════════════════════════════════
    //  Task 2 tests: TraceCollector with app data dir and event writing
    // ══════════════════════════════════════════════════════════════

    use tempfile::TempDir;

    // ── Test 9: finalize writes only trace file (not events) ──

    #[tokio::test]
    async fn finalize_writes_only_trace_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");
        let mut trace = collector.start_session("/tmp/repo", "do the thing", None);
        let session_id = trace.session_id.clone();

        let events: Vec<SessionEvent> = vec![
            SessionEvent::SessionStarted {
                session_id: session_id.clone(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
                plan_file: None,
            },
        ];

        collector
            .finalize(&mut trace, &events)
            .await
            .expect("finalize should succeed");

        let trace_path = base_dir
            .join("traces")
            .join("repo-1")
            .join(format!("trace_{}.json", session_id));
        let events_path = base_dir
            .join("traces")
            .join("repo-1")
            .join(format!("events_{}.json", session_id));

        assert!(trace_path.exists(), "trace file should exist at {:?}", trace_path);
        assert!(!events_path.exists(), "events file should NOT exist at {:?}", events_path);

        // Read back and verify trace
        let trace_json = std::fs::read_to_string(&trace_path).expect("read trace file");
        let restored_trace: SessionTrace =
            serde_json::from_str(&trace_json).expect("deserialize trace");
        assert_eq!(restored_trace.session_id, session_id);
    }

    // ── Test 10: finalize uses full session_id in filenames ──

    #[tokio::test]
    async fn finalize_uses_full_session_id_in_filenames() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");
        let mut trace = collector.start_session("/tmp/repo", "do stuff", None);
        let session_id = trace.session_id.clone();

        let events: Vec<SessionEvent> = vec![];

        let result_path = collector
            .finalize(&mut trace, &events)
            .await
            .expect("finalize should succeed");

        let filename = result_path
            .file_name()
            .expect("should have filename")
            .to_str()
            .expect("valid utf8");

        // The full session_id (a UUID like "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx")
        // should appear in the filename, not just a truncated prefix
        assert!(
            filename.contains(&session_id),
            "filename '{}' should contain the full session_id '{}'",
            filename,
            session_id,
        );
    }

    // ── Test 11: list_traces returns sorted by start_time descending ──

    #[tokio::test]
    async fn list_traces_returns_sorted_by_start_time_desc() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");

        // Create 3 traces with different start_times
        let mut trace1 = collector.start_session("/tmp/repo", "first", None);
        trace1.start_time = Utc::now() - chrono::Duration::hours(3);
        collector
            .finalize(&mut trace1, &[])
            .await
            .expect("finalize trace1");

        let mut trace2 = collector.start_session("/tmp/repo", "second", None);
        trace2.start_time = Utc::now() - chrono::Duration::hours(1);
        collector
            .finalize(&mut trace2, &[])
            .await
            .expect("finalize trace2");

        let mut trace3 = collector.start_session("/tmp/repo", "third", None);
        trace3.start_time = Utc::now() - chrono::Duration::hours(2);
        collector
            .finalize(&mut trace3, &[])
            .await
            .expect("finalize trace3");

        let traces = TraceCollector::list_traces(base_dir, Some("repo-1"))
            .expect("list_traces should succeed");

        assert_eq!(traces.len(), 3);

        // Should be sorted by start_time descending (newest first)
        assert!(
            traces[0].start_time >= traces[1].start_time,
            "traces[0] should be newer than traces[1]"
        );
        assert!(
            traces[1].start_time >= traces[2].start_time,
            "traces[1] should be newer than traces[2]"
        );

        // trace2 was the newest (1 hour ago), trace3 next (2 hours ago), trace1 oldest (3 hours ago)
        assert_eq!(traces[0].prompt, "second");
        assert_eq!(traces[1].prompt, "third");
        assert_eq!(traces[2].prompt, "first");
    }

    // ── Test 12: list_traces across repos ──

    #[tokio::test]
    async fn list_traces_across_repos() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // Write traces to repo-1
        let collector1 = TraceCollector::new(base_dir, "repo-1");
        let mut trace1 = collector1.start_session("/tmp/repo1", "task for repo1", None);
        collector1
            .finalize(&mut trace1, &[])
            .await
            .expect("finalize trace1");

        // Write traces to repo-2
        let collector2 = TraceCollector::new(base_dir, "repo-2");
        let mut trace2 = collector2.start_session("/tmp/repo2", "task for repo2", None);
        collector2
            .finalize(&mut trace2, &[])
            .await
            .expect("finalize trace2");

        let mut trace3 = collector2.start_session("/tmp/repo2", "another task for repo2", None);
        collector2
            .finalize(&mut trace3, &[])
            .await
            .expect("finalize trace3");

        // list_traces with None repo_id should return all traces across repos
        let all_traces = TraceCollector::list_traces(base_dir, None)
            .expect("list_traces across repos should succeed");

        assert_eq!(all_traces.len(), 3, "should find all 3 traces across both repos");
    }

    // ── Test 13: read_trace returns correct trace ──

    #[tokio::test]
    async fn read_trace_returns_correct_trace() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");
        let mut trace = collector.start_session("/tmp/repo", "read me back", Some("plan.md"));
        let session_id = trace.session_id.clone();

        collector
            .finalize(&mut trace, &[])
            .await
            .expect("finalize should succeed");

        let restored = TraceCollector::read_trace(base_dir, "repo-1", &session_id)
            .expect("read_trace should succeed");

        assert_eq!(restored.session_id, session_id);
        assert_eq!(restored.repo_path, "/tmp/repo");
        assert_eq!(restored.prompt, "read me back");
        assert_eq!(restored.plan_file, Some("plan.md".to_string()));
        assert_eq!(restored.outcome, SessionOutcome::Running); // finalize may set end_time but outcome depends on implementation
    }

    // ── Test 14: read_events returns correct events (via append_event) ──

    #[test]
    fn read_events_returns_correct_events() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");
        let session_id = "sess-read-events-test";

        let events: Vec<SessionEvent> = vec![
            SessionEvent::SessionStarted {
                session_id: session_id.to_string(),
            },
            SessionEvent::IterationStarted { iteration: 1 },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Bash".to_string(),
                tool_input: Some(serde_json::json!({"command": "npm test"})),
            },
            SessionEvent::AssistantText {
                iteration: 1,
                text: "Working on it...".to_string(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
                plan_file: None,
            },
        ];

        for event in &events {
            collector
                .append_event(session_id, event)
                .expect("append_event should succeed");
        }

        let restored_events = TraceCollector::read_events(base_dir, "repo-1", session_id)
            .expect("read_events should succeed");

        assert_eq!(restored_events.len(), 5);

        // Verify first event is SessionStarted with the right session_id
        if let SessionEvent::SessionStarted { session_id: sid } = &restored_events[0] {
            assert_eq!(sid.as_str(), session_id);
        } else {
            panic!("expected SessionStarted as first event");
        }

        // Verify last event is SessionComplete with Completed outcome
        if let SessionEvent::SessionComplete { outcome, .. } = &restored_events[4] {
            assert_eq!(outcome.clone(), SessionOutcome::Completed);
        } else {
            panic!("expected SessionComplete as last event");
        }
    }

    // ── Test 15: list_traces on empty/nonexistent dir returns empty vec ──

    #[test]
    fn list_traces_empty_dir() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // Don't create any traces — the repo subdir doesn't even exist
        let traces = TraceCollector::list_traces(base_dir, Some("nonexistent-repo"))
            .expect("list_traces on empty dir should return Ok, not error");

        assert!(traces.is_empty(), "should return empty vec for nonexistent repo dir");
    }

    // ══════════════════════════════════════════════════════════════
    //  Tests for list_latest_traces
    // ══════════════════════════════════════════════════════════════

    // ── Test: list_latest_traces returns one per repo ──

    #[tokio::test]
    async fn list_latest_traces_returns_one_per_repo() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // repo-1: two traces, the second is newer
        let collector1 = TraceCollector::new(base_dir, "repo-1");
        let mut trace1a = collector1.start_session("/tmp/repo1", "repo1 older", None);
        trace1a.start_time = Utc::now() - chrono::Duration::hours(3);
        collector1.finalize(&mut trace1a, &[]).await.expect("finalize trace1a");

        let mut trace1b = collector1.start_session("/tmp/repo1", "repo1 newer", None);
        trace1b.start_time = Utc::now() - chrono::Duration::hours(1);
        collector1.finalize(&mut trace1b, &[]).await.expect("finalize trace1b");

        // repo-2: two traces, the first is newer
        let collector2 = TraceCollector::new(base_dir, "repo-2");
        let mut trace2a = collector2.start_session("/tmp/repo2", "repo2 newer", None);
        trace2a.start_time = Utc::now() - chrono::Duration::hours(2);
        collector2.finalize(&mut trace2a, &[]).await.expect("finalize trace2a");

        let mut trace2b = collector2.start_session("/tmp/repo2", "repo2 older", None);
        trace2b.start_time = Utc::now() - chrono::Duration::hours(5);
        collector2.finalize(&mut trace2b, &[]).await.expect("finalize trace2b");

        let latest = TraceCollector::list_latest_traces(base_dir)
            .expect("list_latest_traces should succeed");

        assert_eq!(latest.len(), 2, "should return exactly one trace per repo");

        // Collect the prompts to verify we got the latest from each repo
        let prompts: Vec<&str> = latest.iter().map(|t| t.prompt.as_str()).collect();
        assert!(prompts.contains(&"repo1 newer"), "should contain the latest trace from repo-1");
        assert!(prompts.contains(&"repo2 newer"), "should contain the latest trace from repo-2");
    }

    // ── Test: list_latest_traces on empty dir returns empty vec ──

    #[tokio::test]
    async fn list_latest_traces_empty_dir() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // No traces written at all — the traces/ directory doesn't even exist
        let latest = TraceCollector::list_latest_traces(base_dir)
            .expect("list_latest_traces on empty dir should return Ok, not error");

        assert!(latest.is_empty(), "should return empty vec when no traces exist");
    }

    // ── Test: list_latest_traces with single repo single trace ──

    #[tokio::test]
    async fn list_latest_traces_single_repo_single_trace() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "only-repo");
        let mut trace = collector.start_session("/tmp/repo", "the only task", None);
        let session_id = trace.session_id.clone();
        collector.finalize(&mut trace, &[]).await.expect("finalize trace");

        let latest = TraceCollector::list_latest_traces(base_dir)
            .expect("list_latest_traces should succeed");

        assert_eq!(latest.len(), 1, "should return exactly one trace");
        assert_eq!(latest[0].session_id, session_id);
        assert_eq!(latest[0].prompt, "the only task");
    }

    // ── Test: list_latest_traces sorted by start_time descending ──

    #[tokio::test]
    async fn list_latest_traces_sorted_by_start_time_desc() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        // Create 3 repos with different latest trace times
        let collector_a = TraceCollector::new(base_dir, "repo-a");
        let mut trace_a = collector_a.start_session("/tmp/a", "repo-a task", None);
        trace_a.start_time = Utc::now() - chrono::Duration::hours(5); // oldest
        collector_a.finalize(&mut trace_a, &[]).await.expect("finalize trace_a");

        let collector_b = TraceCollector::new(base_dir, "repo-b");
        let mut trace_b = collector_b.start_session("/tmp/b", "repo-b task", None);
        trace_b.start_time = Utc::now() - chrono::Duration::hours(1); // newest
        collector_b.finalize(&mut trace_b, &[]).await.expect("finalize trace_b");

        let collector_c = TraceCollector::new(base_dir, "repo-c");
        let mut trace_c = collector_c.start_session("/tmp/c", "repo-c task", None);
        trace_c.start_time = Utc::now() - chrono::Duration::hours(3); // middle
        collector_c.finalize(&mut trace_c, &[]).await.expect("finalize trace_c");

        let latest = TraceCollector::list_latest_traces(base_dir)
            .expect("list_latest_traces should succeed");

        assert_eq!(latest.len(), 3);

        // Should be sorted by start_time descending (newest first)
        assert!(
            latest[0].start_time >= latest[1].start_time,
            "latest[0] should be newer than or equal to latest[1]"
        );
        assert!(
            latest[1].start_time >= latest[2].start_time,
            "latest[1] should be newer than or equal to latest[2]"
        );

        // Verify order: repo-b (1h ago), repo-c (3h ago), repo-a (5h ago)
        assert_eq!(latest[0].prompt, "repo-b task");
        assert_eq!(latest[1].prompt, "repo-c task");
        assert_eq!(latest[2].prompt, "repo-a task");
    }

    // ── Test: list_latest_traces ignores older traces ──

    #[tokio::test]
    async fn list_latest_traces_ignores_older_traces() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "busy-repo");

        // Create 3 traces at different times for the same repo
        let mut trace_old = collector.start_session("/tmp/repo", "oldest task", None);
        trace_old.start_time = Utc::now() - chrono::Duration::hours(10);
        collector.finalize(&mut trace_old, &[]).await.expect("finalize trace_old");

        let mut trace_mid = collector.start_session("/tmp/repo", "middle task", None);
        trace_mid.start_time = Utc::now() - chrono::Duration::hours(5);
        collector.finalize(&mut trace_mid, &[]).await.expect("finalize trace_mid");

        let mut trace_new = collector.start_session("/tmp/repo", "newest task", None);
        trace_new.start_time = Utc::now() - chrono::Duration::hours(1);
        let newest_session_id = trace_new.session_id.clone();
        collector.finalize(&mut trace_new, &[]).await.expect("finalize trace_new");

        let latest = TraceCollector::list_latest_traces(base_dir)
            .expect("list_latest_traces should succeed");

        assert_eq!(latest.len(), 1, "should return only one trace for the single repo");
        assert_eq!(latest[0].session_id, newest_session_id, "should be the newest trace");
        assert_eq!(latest[0].prompt, "newest task");
    }

    // ══════════════════════════════════════════════════════════════
    //  Tests for session_type field
    // ══════════════════════════════════════════════════════════════

    // ── Test: session_trace round-trip preserves session_type ──

    #[test]
    fn session_trace_round_trip_with_session_type() {
        let mut trace = make_test_trace(None);
        trace.session_type = "oneshot".to_string();

        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");
        let restored: SessionTrace =
            serde_json::from_str(&json).expect("deserialize SessionTrace");

        assert_eq!(restored.session_type, "oneshot");
    }

    // ── Test: missing session_type in JSON defaults to "ralph_loop" ──

    #[test]
    fn session_trace_default_session_type() {
        let trace = make_test_trace(None);
        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");

        // Parse into a generic Value, remove session_type, and re-serialize
        let mut value: serde_json::Value =
            serde_json::from_str(&json).expect("parse as Value");
        let obj = value.as_object_mut().expect("top-level object");
        assert!(
            obj.remove("session_type").is_some(),
            "session_type key should have been present"
        );

        let stripped_json =
            serde_json::to_string(&value).expect("re-serialize without session_type");

        let restored: SessionTrace =
            serde_json::from_str(&stripped_json).expect("deserialize without session_type");

        assert_eq!(restored.session_type, "ralph_loop");
    }

    // ── Test: start_session sets session_type to "ralph_loop" ──

    #[test]
    fn start_session_sets_session_type_ralph_loop() {
        let collector = TraceCollector::new("/tmp", "traces");
        let trace = collector.start_session("/tmp/repo", "do stuff", None);

        assert_eq!(trace.session_type, "ralph_loop");
    }

    // ── Test: backward compat — old trace JSON without session_type key ──

    #[test]
    fn session_trace_backward_compat_without_session_type() {
        let trace = make_test_trace(Some("plan.md".to_string()));
        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");

        // Parse into a generic Value, remove session_type to simulate an old-format file
        let mut value: serde_json::Value =
            serde_json::from_str(&json).expect("parse as Value");
        let obj = value.as_object_mut().expect("top-level object");
        assert!(
            obj.remove("session_type").is_some(),
            "session_type key should have been present"
        );

        let old_format_json =
            serde_json::to_string(&value).expect("re-serialize without session_type");

        // Deserialize the old-format JSON — this would fail without the serde default
        let restored: SessionTrace =
            serde_json::from_str(&old_format_json).expect("deserialize old-format trace");

        assert_eq!(restored.session_type, "ralph_loop");
        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.session_id, trace.session_id);
        assert_eq!(restored.repo_path, trace.repo_path);
        assert_eq!(restored.prompt, trace.prompt);
        assert_eq!(restored.plan_file, Some("plan.md".to_string()));
        assert_eq!(restored.total_cost_usd, trace.total_cost_usd);
    }

    // ══════════════════════════════════════════════════════════════
    //  Tests for context window usage tracking
    // ══════════════════════════════════════════════════════════════

    /// Helper to build SpanAttributes with context window fields for testing
    fn make_test_span_attrs(
        iteration: u32,
        final_context_tokens: u64,
        context_window: u64,
    ) -> SpanAttributes {
        use crate::output::{ModelTokenUsage, TokenUsage};
        SpanAttributes {
            iteration,
            claude_session_id: None,
            cost_usd: 0.01,
            num_turns: Some(1),
            api_duration_ms: Some(500),
            completion_signal_found: false,
            exit_code: 0,
            result_preview: "test".to_string(),
            token_usage: TokenUsage {
                input_tokens: 1000,
                output_tokens: 200,
                cache_read_input_tokens: 500,
                cache_creation_input_tokens: 100,
            },
            model_token_usage: HashMap::from([(
                "test-model".to_string(),
                ModelTokenUsage {
                    input_tokens: 1000,
                    output_tokens: 200,
                    cache_read_input_tokens: 500,
                    cache_creation_input_tokens: 100,
                    cost_usd: 0.01,
                    context_window,
                    max_output_tokens: 32000,
                },
            )]),
            final_context_tokens,
        }
    }

    // ── Test A: Backward compat — old trace JSON without context fields ──

    #[test]
    fn session_trace_backward_compat_without_context_fields() {
        let trace = make_test_trace(None);
        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");

        // Parse into a generic Value, remove context_window and final_context_tokens
        // to simulate an old-format file that predates these fields
        let mut value: serde_json::Value =
            serde_json::from_str(&json).expect("parse as Value");
        let obj = value.as_object_mut().expect("top-level object");
        obj.remove("context_window");
        obj.remove("final_context_tokens");

        let old_format_json =
            serde_json::to_string(&value).expect("re-serialize without context fields");

        // Deserialize the old-format JSON — this would fail without #[serde(default)]
        let restored: SessionTrace =
            serde_json::from_str(&old_format_json).expect("deserialize old-format trace");

        assert_eq!(restored.context_window, 0, "context_window should default to 0");
        assert_eq!(
            restored.final_context_tokens, 0,
            "final_context_tokens should default to 0"
        );
        // Verify other fields still round-trip correctly
        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.session_id, trace.session_id);
        assert_eq!(restored.total_cost_usd, trace.total_cost_usd);
    }

    // ── Test B: SessionTrace round-trip with context fields ──

    #[test]
    fn session_trace_round_trip_with_context_fields() {
        let mut trace = make_test_trace(None);
        trace.context_window = 200_000;
        trace.final_context_tokens = 95_000;

        let json = serde_json::to_string(&trace).expect("serialize SessionTrace");
        let restored: SessionTrace =
            serde_json::from_str(&json).expect("deserialize SessionTrace");

        assert_eq!(restored.context_window, 200_000);
        assert_eq!(restored.final_context_tokens, 95_000);
        assert_eq!(restored.trace_id, trace.trace_id);
        assert_eq!(restored.total_cost_usd, trace.total_cost_usd);
    }

    // ── Test C: record_iteration sets context fields (last call wins) ──

    #[test]
    fn record_iteration_sets_context_fields_last_call_wins() {
        let collector = TraceCollector::new("/tmp", "test-repo");
        let mut trace = collector.start_session("/tmp/repo", "context test", None);

        let now = Utc::now();
        let later = now + chrono::Duration::seconds(10);

        // First iteration: context_window=200_000, final_context_tokens=50_000
        let attrs1 = make_test_span_attrs(1, 50_000, 200_000);
        collector.record_iteration(&mut trace, now, later, attrs1, false);

        // After first iteration, trace should reflect first iteration's values
        assert_eq!(trace.context_window, 200_000);
        assert_eq!(trace.final_context_tokens, 50_000);

        // Second iteration: context_window=180_000, final_context_tokens=120_000
        let attrs2 = make_test_span_attrs(2, 120_000, 180_000);
        collector.record_iteration(&mut trace, later, later + chrono::Duration::seconds(10), attrs2, false);

        // After second iteration, trace should reflect the LAST iteration's values
        assert_eq!(
            trace.context_window, 180_000,
            "context_window should be overwritten by last iteration"
        );
        assert_eq!(
            trace.final_context_tokens, 120_000,
            "final_context_tokens should be overwritten by last iteration"
        );
    }

    // ── Test D: finalize recomputes context from last iteration ──

    #[tokio::test]
    async fn finalize_recomputes_context_from_last_iteration() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "test-repo");
        let mut trace = collector.start_session("/tmp/repo", "finalize context test", None);

        let now = Utc::now();

        // Manually construct two iteration spans with different context values
        let span1 = IterationSpan {
            trace_id: trace.trace_id.clone(),
            span_id: "span-iter-1".to_string(),
            parent_span_id: trace.root_span_id.clone(),
            operation_name: "ralph.iteration.1".to_string(),
            start_time: now,
            end_time: now + chrono::Duration::seconds(5),
            duration_ms: 5000,
            status: SpanStatus::Ok,
            attributes: make_test_span_attrs(1, 60_000, 200_000),
        };

        let span2 = IterationSpan {
            trace_id: trace.trace_id.clone(),
            span_id: "span-iter-2".to_string(),
            parent_span_id: trace.root_span_id.clone(),
            operation_name: "ralph.iteration.2".to_string(),
            start_time: now + chrono::Duration::seconds(5),
            end_time: now + chrono::Duration::seconds(10),
            duration_ms: 5000,
            status: SpanStatus::Ok,
            attributes: make_test_span_attrs(2, 150_000, 180_000),
        };

        trace.iterations.push(span1);
        trace.iterations.push(span2);

        // Deliberately set context fields to wrong values before finalize
        trace.context_window = 999;
        trace.final_context_tokens = 999;

        let events: Vec<SessionEvent> = vec![];
        collector
            .finalize(&mut trace, &events)
            .await
            .expect("finalize should succeed");

        // finalize should recompute context_window and final_context_tokens
        // from the LAST iteration
        assert_eq!(
            trace.context_window, 180_000,
            "finalize should set context_window from last iteration's model_token_usage"
        );
        assert_eq!(
            trace.final_context_tokens, 150_000,
            "finalize should set final_context_tokens from last iteration's SpanAttributes"
        );
    }

    // ── Test: backward compat — old IterationSpan without final_context_tokens ──

    #[test]
    fn span_attributes_backward_compat_without_final_context_tokens() {
        // Build a SpanAttributes, serialize it, strip final_context_tokens, deserialize
        let attrs = make_test_span_attrs(1, 50000, 200000);
        let json = serde_json::to_string(&attrs).expect("serialize SpanAttributes");

        let mut value: serde_json::Value = serde_json::from_str(&json).expect("parse as Value");
        let obj = value.as_object_mut().expect("top-level object");
        assert!(
            obj.remove("final_context_tokens").is_some(),
            "final_context_tokens key should have been present"
        );

        let old_format_json = serde_json::to_string(&value).expect("re-serialize");
        let restored: SpanAttributes =
            serde_json::from_str(&old_format_json).expect("deserialize old-format SpanAttributes");

        assert_eq!(restored.final_context_tokens, 0);
        assert_eq!(restored.iteration, 1);
    }

    // ══════════════════════════════════════════════════════════════
    //  Tests for JSONL append/read functionality
    // ══════════════════════════════════════════════════════════════

    /// Helper: build a list of diverse SessionEvent variants for JSONL testing
    fn make_test_events(session_id: &str) -> Vec<SessionEvent> {
        vec![
            SessionEvent::SessionStarted {
                session_id: session_id.to_string(),
            },
            SessionEvent::IterationStarted { iteration: 1 },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Bash".to_string(),
                tool_input: Some(serde_json::json!({"command": "cargo test"})),
            },
            SessionEvent::AssistantText {
                iteration: 1,
                text: "Running tests now...".to_string(),
            },
            SessionEvent::IterationComplete {
                iteration: 1,
                result: make_test_result_event(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
                plan_file: None,
            },
        ]
    }

    // ── Test: append_event writes valid JSONL ──

    #[test]
    fn append_event_writes_valid_jsonl() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-jsonl");

        // Create the output directory so append_event can write
        let output_dir = base_dir.join("traces").join("repo-jsonl");
        std::fs::create_dir_all(&output_dir).expect("create output dir");

        let session_id = "sess-jsonl-001";
        let events = make_test_events(session_id);

        // Append each event individually
        for event in &events {
            collector
                .append_event(session_id, event)
                .expect("append_event should succeed");
        }

        // Read the file manually and verify each line is valid JSON
        let jsonl_path = output_dir.join(format!("events_{}.jsonl", session_id));
        assert!(jsonl_path.exists(), "JSONL file should exist at {:?}", jsonl_path);

        let contents = std::fs::read_to_string(&jsonl_path).expect("read JSONL file");
        let lines: Vec<&str> = contents.lines().collect();

        assert_eq!(
            lines.len(),
            events.len(),
            "should have one line per appended event"
        );

        // Each line should deserialize to a valid SessionEvent
        for (i, line) in lines.iter().enumerate() {
            let parsed: SessionEvent = serde_json::from_str(line)
                .unwrap_or_else(|e| panic!("line {} should be valid JSON: {}", i, e));

            // Spot-check the first and last events
            if i == 0 {
                match &parsed {
                    SessionEvent::SessionStarted { session_id: sid } => {
                        assert_eq!(sid, "sess-jsonl-001");
                    }
                    other => panic!("expected SessionStarted as first event, got {:?}", other),
                }
            }
            if i == lines.len() - 1 {
                match &parsed {
                    SessionEvent::SessionComplete { outcome, .. } => {
                        assert_eq!(*outcome, SessionOutcome::Completed);
                    }
                    other => panic!("expected SessionComplete as last event, got {:?}", other),
                }
            }
        }
    }

    // ── Test: read_events reads JSONL correctly ──

    #[test]
    fn read_events_reads_jsonl_correctly() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let repo_id = "repo-jsonl-read";
        let session_id = "sess-jsonl-002";

        // Create the directory structure
        let output_dir = base_dir.join("traces").join(repo_id);
        std::fs::create_dir_all(&output_dir).expect("create output dir");

        // Write a JSONL file manually (one JSON object per line)
        let events = vec![
            SessionEvent::SessionStarted {
                session_id: session_id.to_string(),
            },
            SessionEvent::IterationStarted { iteration: 1 },
            SessionEvent::AssistantText {
                iteration: 1,
                text: "Hello world".to_string(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
                plan_file: None,
            },
        ];

        let jsonl_path = output_dir.join(format!("events_{}.jsonl", session_id));
        let mut content = String::new();
        for event in &events {
            let line = serde_json::to_string(event).expect("serialize event");
            content.push_str(&line);
            content.push('\n');
        }
        std::fs::write(&jsonl_path, &content).expect("write JSONL file");

        // Now use read_events to read them back
        let restored = TraceCollector::read_events(base_dir, repo_id, session_id)
            .expect("read_events should succeed");

        assert_eq!(restored.len(), 4, "should read all 4 events");

        // Verify first event
        match &restored[0] {
            SessionEvent::SessionStarted { session_id: sid } => {
                assert_eq!(sid, session_id);
            }
            other => panic!("expected SessionStarted, got {:?}", other),
        }

        // Verify last event
        match &restored[3] {
            SessionEvent::SessionComplete { outcome, .. } => {
                assert_eq!(*outcome, SessionOutcome::Completed);
            }
            other => panic!("expected SessionComplete, got {:?}", other),
        }
    }

    // ── Test: round-trip — append then read ──

    #[test]
    fn append_then_read_round_trip() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let repo_id = "repo-roundtrip";
        let session_id = "sess-roundtrip-001";

        let collector = TraceCollector::new(base_dir, repo_id);

        // Create the output directory
        let output_dir = base_dir.join("traces").join(repo_id);
        std::fs::create_dir_all(&output_dir).expect("create output dir");

        let events = make_test_events(session_id);

        // Append each event
        for event in &events {
            collector
                .append_event(session_id, event)
                .expect("append_event should succeed");
        }

        // Read them back using read_events
        let restored = TraceCollector::read_events(base_dir, repo_id, session_id)
            .expect("read_events should succeed");

        assert_eq!(
            restored.len(),
            events.len(),
            "should read back the same number of events"
        );

        // Verify each event matches by serializing both and comparing JSON
        for (i, (original, roundtripped)) in events.iter().zip(restored.iter()).enumerate() {
            let orig_json = serde_json::to_string(original).expect("serialize original");
            let rt_json = serde_json::to_string(roundtripped).expect("serialize roundtripped");
            assert_eq!(
                orig_json, rt_json,
                "event {} should match after round-trip",
                i
            );
        }
    }

    // ── Test: empty file returns empty vec ──

    #[test]
    fn read_events_empty_file_returns_empty_vec() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let repo_id = "repo-empty";
        let session_id = "sess-empty-001";

        // Create the directory structure and an empty JSONL file
        let output_dir = base_dir.join("traces").join(repo_id);
        std::fs::create_dir_all(&output_dir).expect("create output dir");

        let jsonl_path = output_dir.join(format!("events_{}.jsonl", session_id));
        std::fs::write(&jsonl_path, "").expect("write empty JSONL file");

        let restored = TraceCollector::read_events(base_dir, repo_id, session_id)
            .expect("read_events on empty file should return Ok");

        assert!(
            restored.is_empty(),
            "should return empty vec for empty JSONL file"
        );
    }

    // ── Test: finalize does NOT create events file ──

    #[tokio::test]
    async fn finalize_does_not_create_events_file() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-no-events");
        let mut trace = collector.start_session("/tmp/repo", "finalize test", None);
        let session_id = trace.session_id.clone();

        let events: Vec<SessionEvent> = vec![
            SessionEvent::SessionStarted {
                session_id: session_id.clone(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
                plan_file: None,
            },
        ];

        collector
            .finalize(&mut trace, &events)
            .await
            .expect("finalize should succeed");

        // The trace file SHOULD exist
        let trace_path = base_dir
            .join("traces")
            .join("repo-no-events")
            .join(format!("trace_{}.json", session_id));
        assert!(
            trace_path.exists(),
            "trace file should exist at {:?}",
            trace_path
        );

        // The events file SHOULD NOT exist (finalize should no longer write it)
        let events_json_path = base_dir
            .join("traces")
            .join("repo-no-events")
            .join(format!("events_{}.json", session_id));
        let events_jsonl_path = base_dir
            .join("traces")
            .join("repo-no-events")
            .join(format!("events_{}.jsonl", session_id));

        assert!(
            !events_json_path.exists(),
            "events .json file should NOT exist after finalize (got {:?})",
            events_json_path
        );
        assert!(
            !events_jsonl_path.exists(),
            "events .jsonl file should NOT exist after finalize (got {:?})",
            events_jsonl_path
        );
    }

    // ══════════════════════════════════════════════════════════════
    //  Tests for session_id in ActiveSessions
    // ══════════════════════════════════════════════════════════════

    // ── Test: start_session_with_id uses provided session_id ──

    #[test]
    fn start_session_with_provided_session_id() {
        let tmp = TempDir::new().expect("create temp dir");
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let session_id = "my-custom-session-id".to_string();
        let trace = collector.start_session_with_id(&session_id, "/test/repo", "test prompt", None);
        assert_eq!(trace.session_id, session_id);
    }

    // ── Test: start_session still generates unique IDs ──

    #[test]
    fn start_session_generates_unique_id() {
        let tmp = TempDir::new().expect("create temp dir");
        let collector = TraceCollector::new(tmp.path(), "test-repo");
        let trace1 = collector.start_session("/test/repo", "prompt1", None);
        let trace2 = collector.start_session("/test/repo", "prompt2", None);
        assert_ne!(trace1.session_id, trace2.session_id);
        assert!(!trace1.session_id.is_empty());
    }

    // ── Test: append and read with provided session_id ──

    #[test]
    fn append_and_read_with_provided_session_id() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "test-repo");
        let session_id = "custom-session-123";

        let event = SessionEvent::SessionStarted {
            session_id: session_id.to_string(),
        };
        collector
            .append_event(session_id, &event)
            .expect("append_event should succeed");

        let events = TraceCollector::read_events(base_dir, "test-repo", session_id)
            .expect("read_events should succeed");
        assert_eq!(events.len(), 1);

        // Verify the event round-tripped correctly
        match &events[0] {
            SessionEvent::SessionStarted {
                session_id: sid,
            } => {
                assert_eq!(sid, session_id);
            }
            other => panic!("expected SessionStarted, got {:?}", other),
        }
    }

    #[test]
    fn test_print_trace_summary_emits_tracing_output() {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::fmt;
        use tracing_subscriber::fmt::MakeWriter;

        // Newtype wrapper so we can implement io::Write for Arc<Mutex<Vec<u8>>>
        #[derive(Clone)]
        struct SharedWriter(Arc<Mutex<Vec<u8>>>);

        impl std::io::Write for SharedWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().write(buf)
            }
            fn flush(&mut self) -> std::io::Result<()> {
                self.0.lock().unwrap().flush()
            }
        }

        impl<'a> MakeWriter<'a> for SharedWriter {
            type Writer = SharedWriter;
            fn make_writer(&'a self) -> Self::Writer {
                self.clone()
            }
        }

        let mut trace = make_test_trace(None);

        // Add iteration spans so the per-iteration loop is exercised
        let now = Utc::now();
        let span1 = IterationSpan {
            trace_id: trace.trace_id.clone(),
            span_id: "span-iter-1".to_string(),
            parent_span_id: trace.root_span_id.clone(),
            operation_name: "ralph.iteration.1".to_string(),
            start_time: now,
            end_time: now + chrono::Duration::seconds(3),
            duration_ms: 3000,
            status: SpanStatus::Ok,
            attributes: make_test_span_attrs(1, 60_000, 200_000),
        };
        let span2 = IterationSpan {
            trace_id: trace.trace_id.clone(),
            span_id: "span-iter-2".to_string(),
            parent_span_id: trace.root_span_id.clone(),
            operation_name: "ralph.iteration.2".to_string(),
            start_time: now + chrono::Duration::seconds(3),
            end_time: now + chrono::Duration::seconds(8),
            duration_ms: 5000,
            status: SpanStatus::Error,
            attributes: SpanAttributes {
                iteration: 2,
                claude_session_id: None,
                cost_usd: 0.07,
                num_turns: Some(4),
                api_duration_ms: Some(900),
                completion_signal_found: false,
                exit_code: 1,
                result_preview: "failed".to_string(),
                token_usage: TokenUsage {
                    input_tokens: 2500,
                    output_tokens: 800,
                    cache_read_input_tokens: 300,
                    cache_creation_input_tokens: 50,
                },
                model_token_usage: HashMap::from([(
                    "test-model".to_string(),
                    ModelTokenUsage {
                        input_tokens: 2500,
                        output_tokens: 800,
                        cache_read_input_tokens: 300,
                        cache_creation_input_tokens: 50,
                        cost_usd: 0.07,
                        context_window: 200_000,
                        max_output_tokens: 32000,
                    },
                )]),
                final_context_tokens: 80_000,
            },
        };
        trace.iterations.push(span1);
        trace.iterations.push(span2);

        let buffer = Arc::new(Mutex::new(Vec::new()));
        let writer = SharedWriter(buffer.clone());

        // Build a subscriber that writes to the shared buffer
        let subscriber = fmt::Subscriber::builder()
            .with_writer(writer)
            .with_max_level(tracing::Level::INFO)
            .without_time()
            .with_ansi(false)
            .finish();

        // Run print_trace_summary under the test subscriber
        tracing::subscriber::with_default(subscriber, || {
            print_trace_summary(&trace);
        });

        let output = String::from_utf8(buffer.lock().unwrap().clone()).unwrap();

        // Verify key fields appear in the captured tracing output
        assert!(
            output.contains("abc123"),
            "expected trace_id 'abc123' in output: {output}"
        );
        assert!(
            output.contains("sess-789"),
            "expected session_id 'sess-789' in output: {output}"
        );
        assert!(
            output.contains("/tmp/repo"),
            "expected repo_path '/tmp/repo' in output: {output}"
        );
        assert!(
            output.contains("Completed"),
            "expected outcome 'Completed' in output: {output}"
        );
        assert!(
            output.contains("1.23"),
            "expected cost '1.23' in output: {output}"
        );
        assert!(
            output.contains("100"),
            "expected input token count '100' in output: {output}"
        );
        assert!(
            output.contains("50"),
            "expected output token count '50' in output: {output}"
        );

        // Verify iteration 1 breakdown appears
        assert!(
            output.contains("Iteration 1"),
            "expected 'Iteration 1' in output: {output}"
        );
        assert!(
            output.contains("iteration=1"),
            "expected structured field 'iteration=1' in output: {output}"
        );
        assert!(
            output.contains("duration_ms=3000"),
            "expected structured field 'duration_ms=3000' in output: {output}"
        );
        assert!(
            output.contains("3000ms"),
            "expected '3000ms' in iteration 1 message: {output}"
        );
        assert!(
            output.contains("input_tokens=1000"),
            "expected structured field 'input_tokens=1000' in output: {output}"
        );

        // Verify iteration 2 breakdown appears with distinct values
        assert!(
            output.contains("Iteration 2"),
            "expected 'Iteration 2' in output: {output}"
        );
        assert!(
            output.contains("iteration=2"),
            "expected structured field 'iteration=2' in output: {output}"
        );
        assert!(
            output.contains("duration_ms=5000"),
            "expected structured field 'duration_ms=5000' in output: {output}"
        );
        assert!(
            output.contains("5000ms"),
            "expected '5000ms' in iteration 2 message: {output}"
        );
        assert!(
            output.contains("cost=0.07"),
            "expected structured field 'cost=0.07' in output: {output}"
        );
        assert!(
            output.contains("turns=4"),
            "expected structured field 'turns=4' in output: {output}"
        );
        assert!(
            output.contains("input_tokens=2500"),
            "expected structured field 'input_tokens=2500' in output: {output}"
        );
        assert!(
            output.contains("status=Error"),
            "expected 'status=Error' for iteration 2 in output: {output}"
        );
    }
}

/// Log a session trace summary via tracing
pub fn print_trace_summary(trace: &SessionTrace) {
    let duration_str = trace
        .end_time
        .map(|end| format!("{}s", (end - trace.start_time).num_seconds()))
        .unwrap_or_else(|| "in progress".to_string());

    tracing::info!(
        trace_id = %trace.trace_id,
        session_id = %trace.session_id,
        "Ralph session trace: repo={}, outcome={:?}, iterations={}, \
         cost=${:.4}, tokens={} in / {} out / {} cache-read / {} cache-create, \
         duration={}",
        trace.repo_path,
        trace.outcome,
        trace.total_iterations,
        trace.total_cost_usd,
        trace.total_input_tokens,
        trace.total_output_tokens,
        trace.total_cache_read_tokens,
        trace.total_cache_creation_tokens,
        duration_str,
    );

    for span in &trace.iterations {
        tracing::info!(
            iteration = span.attributes.iteration,
            duration_ms = span.duration_ms,
            cost = span.attributes.cost_usd,
            turns = span.attributes.num_turns.unwrap_or(0),
            input_tokens = span.attributes.token_usage.input_tokens,
            "Iteration {}: status={:?}, cost=${:.4}, {}ms, {} turns, {} in-tokens",
            span.attributes.iteration,
            span.status,
            span.attributes.cost_usd,
            span.duration_ms,
            span.attributes.num_turns.unwrap_or(0),
            span.attributes.token_usage.input_tokens,
        );
    }
}
