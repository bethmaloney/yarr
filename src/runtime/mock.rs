use anyhow::Result;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::{ProcessOutput, RuntimeProvider};

pub struct MockRuntime {
    responses: Vec<String>,
    call_count: AtomicUsize,
}

impl MockRuntime {
    pub fn new(responses: Vec<String>) -> Self {
        assert!(!responses.is_empty(), "MockRuntime needs at least one response");
        Self {
            responses,
            call_count: AtomicUsize::new(0),
        }
    }

    /// Create a mock that simulates N working iterations then a completion
    pub fn completing_after(iterations: usize) -> Self {
        let mut responses = Vec::new();
        for i in 0..iterations {
            responses.push(mock_json_response(
                &format!("Working on task... iteration {}", i + 1),
                false,
                i as u32 + 1,
            ));
        }
        responses.push(mock_json_response(
            "All tasks complete. <promise>COMPLETE</promise>",
            false,
            iterations as u32 + 1,
        ));
        Self::new(responses)
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for MockRuntime {
    fn name(&self) -> &str {
        "mock"
    }

    async fn run_claude(
        &self,
        _prompt: &str,
        _working_dir: &Path,
        _extra_args: &[String],
    ) -> Result<ProcessOutput> {
        let idx = self.call_count.fetch_add(1, Ordering::SeqCst);
        let response_idx = idx.min(self.responses.len() - 1);

        // Simulate some processing time
        tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;

        Ok(ProcessOutput {
            stdout: self.responses[response_idx].clone(),
            stderr: String::new(),
            exit_code: 0,
            wall_time_ms: 200,
        })
    }

    async fn health_check(&self) -> Result<()> {
        Ok(())
    }
}

fn mock_json_response(result_text: &str, is_error: bool, num_turns: u32) -> String {
    let subtype = if is_error { "error" } else { "success" };
    let cost = 0.002 * num_turns as f64;
    let duration = 800 * num_turns as u64;
    let session_id = uuid::Uuid::new_v4();

    serde_json::json!({
        "type": "result",
        "subtype": subtype,
        "total_cost_usd": cost,
        "is_error": is_error,
        "duration_ms": duration,
        "duration_api_ms": (duration as f64 * 0.7) as u64,
        "num_turns": num_turns,
        "result": result_text,
        "session_id": session_id.to_string()
    })
    .to_string()
}
