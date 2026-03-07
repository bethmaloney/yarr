use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
pub struct TraceCollector {
    output_dir: PathBuf,
    repo_id: String,
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
        trace.iterations.push(span);
    }

    /// Finalize and persist the session trace to disk
    pub async fn finalize(
        &self,
        trace: &mut SessionTrace,
        events: &[crate::session::SessionEvent],
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

        tokio::fs::create_dir_all(&self.output_dir).await?;

        let trace_filename = format!("trace_{}.json", trace.session_id);
        let trace_path = self.output_dir.join(&trace_filename);

        let json = serde_json::to_string_pretty(trace)?;
        tokio::fs::write(&trace_path, json).await?;

        let events_filename = format!("events_{}.json", trace.session_id);
        let events_path = self.output_dir.join(&events_filename);

        let events_json = serde_json::to_string_pretty(events)?;
        tokio::fs::write(&events_path, events_json).await?;

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
            .join(format!("events_{}.json", session_id));
        let contents = std::fs::read_to_string(&path)?;
        let events: Vec<crate::session::SessionEvent> = serde_json::from_str(&contents)?;
        Ok(events)
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

    // ── Test 9: finalize writes both trace and events files ──

    #[tokio::test]
    async fn finalize_writes_both_trace_and_events_files() {
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
        assert!(events_path.exists(), "events file should exist at {:?}", events_path);

        // Read back and verify trace
        let trace_json = std::fs::read_to_string(&trace_path).expect("read trace file");
        let restored_trace: SessionTrace =
            serde_json::from_str(&trace_json).expect("deserialize trace");
        assert_eq!(restored_trace.session_id, session_id);

        // Read back and verify events
        let events_json = std::fs::read_to_string(&events_path).expect("read events file");
        let restored_events: Vec<SessionEvent> =
            serde_json::from_str(&events_json).expect("deserialize events");
        assert_eq!(restored_events.len(), 2);
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

    // ── Test 14: read_events returns correct events ──

    #[tokio::test]
    async fn read_events_returns_correct_events() {
        let tmp = TempDir::new().expect("create temp dir");
        let base_dir = tmp.path();

        let collector = TraceCollector::new(base_dir, "repo-1");
        let mut trace = collector.start_session("/tmp/repo", "events test", None);
        let session_id = trace.session_id.clone();

        let events: Vec<SessionEvent> = vec![
            SessionEvent::SessionStarted {
                session_id: session_id.clone(),
            },
            SessionEvent::IterationStarted { iteration: 1 },
            SessionEvent::ToolUse {
                iteration: 1,
                tool_name: "Bash".to_string(),
            },
            SessionEvent::AssistantText {
                iteration: 1,
                text: "Working on it...".to_string(),
            },
            SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
            },
        ];

        collector
            .finalize(&mut trace, &events)
            .await
            .expect("finalize should succeed");

        let restored_events = TraceCollector::read_events(base_dir, "repo-1", &session_id)
            .expect("read_events should succeed");

        assert_eq!(restored_events.len(), 5);

        // Verify first event is SessionStarted with the right session_id
        if let SessionEvent::SessionStarted { session_id: sid } = &restored_events[0] {
            assert_eq!(sid.as_str(), session_id.as_str());
        } else {
            panic!("expected SessionStarted as first event");
        }

        // Verify last event is SessionComplete with Completed outcome
        if let SessionEvent::SessionComplete { outcome } = &restored_events[4] {
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
}

/// Pretty-print a session trace summary to stdout
pub fn print_trace_summary(trace: &SessionTrace) {
    println!("\n{}", "=".repeat(60));
    println!("  RALPH SESSION TRACE SUMMARY");
    println!("{}", "=".repeat(60));
    println!("  Trace ID:    {}", trace.trace_id);
    println!("  Session:     {}", trace.session_id);
    println!("  Repo:        {}", trace.repo_path);
    println!("  Outcome:     {:?}", trace.outcome);
    println!("  Iterations:  {}", trace.total_iterations);
    println!("  Total cost:  ${:.4}", trace.total_cost_usd);
    println!(
        "  Tokens:      {} in / {} out / {} cache-read / {} cache-create",
        trace.total_input_tokens,
        trace.total_output_tokens,
        trace.total_cache_read_tokens,
        trace.total_cache_creation_tokens,
    );

    if let Some(end) = trace.end_time {
        let duration = end - trace.start_time;
        println!("  Duration:    {}s", duration.num_seconds());
    }

    println!("\n  ITERATION BREAKDOWN:");
    println!(
        "  {:<6} {:<10} {:<10} {:<10} {:<12} {:<8}",
        "Iter", "Duration", "Cost", "Turns", "In tokens", "Status"
    );
    println!(
        "  {:-<6} {:-<10} {:-<10} {:-<10} {:-<12} {:-<8}",
        "", "", "", "", "", ""
    );

    for span in &trace.iterations {
        println!(
            "  {:<6} {:<10} ${:<9.4} {:<10} {:<12} {:?}",
            span.attributes.iteration,
            format!("{}ms", span.duration_ms),
            span.attributes.cost_usd,
            span.attributes.num_turns.unwrap_or(0),
            span.attributes.token_usage.input_tokens,
            span.status,
        );
    }
    println!("{}\n", "=".repeat(60));
}
