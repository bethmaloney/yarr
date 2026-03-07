use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
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
    pub plan_file: Option<String>,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub outcome: SessionOutcome,
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
}

impl TraceCollector {
    pub fn new(output_dir: impl Into<PathBuf>) -> Self {
        Self {
            output_dir: output_dir.into(),
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
            start_time: Utc::now(),
            end_time: None,
            outcome: SessionOutcome::Running,
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
    pub async fn finalize(&self, trace: &mut SessionTrace) -> anyhow::Result<PathBuf> {
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

        let filename = format!(
            "trace_{}_{}.json",
            trace.session_id.split('-').next().unwrap_or("unknown"),
            trace.start_time.format("%Y%m%d_%H%M%S")
        );
        let path = self.output_dir.join(&filename);

        let json = serde_json::to_string_pretty(trace)?;
        tokio::fs::write(&path, json).await?;

        Ok(path)
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
            start_time: Utc::now(),
            end_time: Some(Utc::now()),
            outcome: SessionOutcome::Completed,
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
        let collector = TraceCollector::new("/tmp/traces");
        let trace = collector.start_session("/tmp/repo", "do stuff", Some("plan.md"));

        assert_eq!(trace.plan_file, Some("plan.md".to_string()));
        assert_eq!(trace.repo_path, "/tmp/repo");
        assert_eq!(trace.prompt, "do stuff");
        assert_eq!(trace.outcome, SessionOutcome::Running);
    }

    // ── Test 7: start_session with plan_file None ──

    #[test]
    fn start_session_without_plan_file() {
        let collector = TraceCollector::new("/tmp/traces");
        let trace = collector.start_session("/tmp/repo", "do stuff", None);

        assert_eq!(trace.plan_file, None);
        assert_eq!(trace.repo_path, "/tmp/repo");
        assert_eq!(trace.prompt, "do stuff");
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
