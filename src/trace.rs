use chrono::{DateTime, Utc};
use serde::Serialize;
use std::path::PathBuf;
use uuid::Uuid;

/// A single span representing one Ralph iteration
#[derive(Debug, Serialize, Clone)]
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
#[derive(Debug, Serialize, Clone)]
pub struct SessionTrace {
    pub trace_id: String,
    pub root_span_id: String,
    pub session_id: String,
    pub repo_path: String,
    pub prompt: String,
    pub start_time: DateTime<Utc>,
    pub end_time: Option<DateTime<Utc>>,
    pub outcome: SessionOutcome,
    pub iterations: Vec<IterationSpan>,
    pub total_cost_usd: f64,
    pub total_iterations: u32,
}

#[derive(Debug, Serialize, Clone)]
pub struct SpanAttributes {
    pub iteration: u32,
    pub claude_session_id: Option<String>,
    pub cost_usd: f64,
    pub num_turns: Option<u32>,
    pub api_duration_ms: Option<u64>,
    pub completion_signal_found: bool,
    pub exit_code: i32,
    pub result_preview: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SpanStatus {
    Ok,
    Error,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
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
    pub fn start_session(&self, repo_path: &str, prompt: &str) -> SessionTrace {
        let trace_id = Uuid::new_v4().to_string().replace('-', "");
        let root_span_id = Uuid::new_v4().to_string().replace('-', "")[..16].to_string();

        SessionTrace {
            trace_id,
            root_span_id,
            session_id: Uuid::new_v4().to_string(),
            repo_path: repo_path.to_string(),
            prompt: prompt.to_string(),
            start_time: Utc::now(),
            end_time: None,
            outcome: SessionOutcome::Running,
            iterations: Vec::new(),
            total_cost_usd: 0.0,
            total_iterations: 0,
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

    if let Some(end) = trace.end_time {
        let duration = end - trace.start_time;
        println!("  Duration:    {}s", duration.num_seconds());
    }

    println!("\n  ITERATION BREAKDOWN:");
    println!(
        "  {:<6} {:<10} {:<10} {:<10} {:<8}",
        "Iter", "Duration", "Cost", "Turns", "Status"
    );
    println!(
        "  {:-<6} {:-<10} {:-<10} {:-<10} {:-<8}",
        "", "", "", "", ""
    );

    for span in &trace.iterations {
        println!(
            "  {:<6} {:<10} ${:<9.4} {:<10} {:?}",
            span.attributes.iteration,
            format!("{}ms", span.duration_ms),
            span.attributes.cost_usd,
            span.attributes.num_turns.unwrap_or(0),
            span.status,
        );
    }
    println!("{}\n", "=".repeat(60));
}
