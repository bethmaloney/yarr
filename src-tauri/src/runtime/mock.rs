use anyhow::Result;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::mpsc;

use super::{ClaudeInvocation, ProcessExit, RunningProcess, RuntimeProvider, TaskAbortHandle};
use crate::output::*;

pub struct MockRuntime {
    scenarios: Vec<MockScenario>,
    call_count: AtomicUsize,
}

/// What a single mock invocation should emit
struct MockScenario {
    text: String,
    is_error: bool,
    num_turns: u32,
    tool_uses: Vec<String>,
}

impl MockRuntime {
    /// Create a mock that simulates N working iterations then a completion
    pub fn completing_after(iterations: usize) -> Self {
        let mut scenarios = Vec::new();
        for i in 0..iterations {
            scenarios.push(MockScenario {
                text: format!("Working on task... iteration {}", i + 1),
                is_error: false,
                num_turns: i as u32 + 1,
                tool_uses: vec!["Read".to_string(), "Edit".to_string()],
            });
        }
        scenarios.push(MockScenario {
            text: "All tasks complete. <promise>COMPLETE</promise>".to_string(),
            is_error: false,
            num_turns: iterations as u32 + 1,
            tool_uses: vec!["Read".to_string(), "Write".to_string()],
        });
        Self {
            scenarios,
            call_count: AtomicUsize::new(0),
        }
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for MockRuntime {
    fn name(&self) -> &str {
        "mock"
    }

    async fn spawn_claude(&self, _invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let idx = self.call_count.fetch_add(1, Ordering::SeqCst);
        let scenario = &self.scenarios[idx.min(self.scenarios.len() - 1)];

        let session_id = uuid::Uuid::new_v4().to_string();
        let cost = 0.002 * scenario.num_turns as f64;
        let duration = 800 * scenario.num_turns as u64;

        // Build the events this mock invocation will emit
        let mut events: Vec<StreamEvent> = Vec::new();

        // 1. system/init
        events.push(StreamEvent::System(SystemEvent {
            subtype: Some("init".to_string()),
            session_id: Some(session_id.clone()),
            cwd: Some("/mock/repo".to_string()),
            model: Some("mock-model".to_string()),
            tools: Some(vec!["Read".to_string(), "Write".to_string(), "Bash".to_string()]),
        }));

        // 2. assistant tool_use events
        for tool in &scenario.tool_uses {
            events.push(StreamEvent::Assistant(AssistantEvent {
                message: AssistantMessage {
                    id: Some(format!("msg_{}", uuid::Uuid::new_v4())),
                    role: Some("assistant".to_string()),
                    model: Some("mock-model".to_string()),
                    content: vec![ContentBlock::ToolUse {
                        id: format!("toolu_{}", uuid::Uuid::new_v4()),
                        name: tool.clone(),
                        input: serde_json::json!({}),
                    }],
                    stop_reason: None,
                    usage: None,
                },
                session_id: Some(session_id.clone()),
            }));
        }

        // 3. assistant text response
        events.push(StreamEvent::Assistant(AssistantEvent {
            message: AssistantMessage {
                id: Some(format!("msg_{}", uuid::Uuid::new_v4())),
                role: Some("assistant".to_string()),
                model: Some("mock-model".to_string()),
                content: vec![ContentBlock::Text {
                    text: scenario.text.clone(),
                }],
                stop_reason: Some("end_turn".to_string()),
                usage: Some(Usage {
                    input_tokens: Some(100),
                    output_tokens: Some(50),
                    cache_read_input_tokens: None,
                    cache_creation_input_tokens: None,
                }),
            },
            session_id: Some(session_id.clone()),
        }));

        // 4. result
        let input_tokens = 5000 + 2000 * scenario.num_turns as u64;
        let output_tokens = 500 * scenario.num_turns as u64;
        let cache_read = if idx > 0 { 4000u64 } else { 0u64 };
        let cache_create = if idx == 0 { 5000u64 } else { 1000u64 };

        let subtype = if scenario.is_error { "error" } else { "success" };
        events.push(StreamEvent::Result(ResultEvent {
            subtype: Some(subtype.to_string()),
            is_error: scenario.is_error,
            duration_ms: Some(duration),
            duration_api_ms: Some((duration as f64 * 0.7) as u64),
            num_turns: Some(scenario.num_turns),
            result: Some(scenario.text.clone()),
            session_id: Some(session_id),
            total_cost_usd: Some(cost),
            stop_reason: Some("end_turn".to_string()),
            usage: Some(serde_json::json!({
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cache_read_input_tokens": cache_read,
                "cache_creation_input_tokens": cache_create,
            })),
            model_usage: Some(HashMap::from([(
                "mock-model".to_string(),
                serde_json::json!({
                    "inputTokens": input_tokens,
                    "outputTokens": output_tokens,
                    "cacheReadInputTokens": cache_read,
                    "cacheCreationInputTokens": cache_create,
                    "costUSD": cost,
                    "contextWindow": 200000,
                    "maxOutputTokens": 32000,
                }),
            )])),
        }));

        let (tx, rx) = mpsc::channel(64);

        let completion = tokio::spawn(async move {
            // Emit events with small delays to simulate streaming
            for event in events {
                tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
                if tx.send(event).await.is_err() {
                    break;
                }
            }
            // Small delay to simulate process exit
            tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
            Ok(ProcessExit {
                exit_code: 0,
                wall_time_ms: 200,
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

    async fn health_check(&self) -> Result<()> {
        Ok(())
    }
}
