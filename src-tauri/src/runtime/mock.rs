use anyhow::Result;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

use super::{ClaudeInvocation, CommandOutput, ProcessExit, RunningProcess, RuntimeProvider, TaskAbortHandle};
use crate::output::*;

pub struct MockRuntime {
    scenarios: Vec<MockScenario>,
    call_count: AtomicUsize,
    pub command_results: Vec<CommandOutput>,
    command_call_count: AtomicUsize,
    pub env_override: Option<HashMap<String, String>>,
    pub captured_commands: Arc<Mutex<Vec<String>>>,
    /// If set, inject a compact_boundary system event during each iteration.
    inject_compaction: Option<(u64, String)>,
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
            command_results: Vec::new(),
            command_call_count: AtomicUsize::new(0),
            env_override: None,
            captured_commands: Arc::new(Mutex::new(Vec::new())),
            inject_compaction: None,
        }
    }

    /// Configure the mock to inject a `compact_boundary` system event into each iteration's
    /// event stream (inserted after the init event and before assistant messages).
    pub fn with_compaction(mut self, pre_tokens: u64, trigger: &str) -> Self {
        self.inject_compaction = Some((pre_tokens, trigger.to_string()));
        self
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
            compact_metadata: None,
        }));

        // 1b. optional compact_boundary event
        if let Some((pre_tokens, ref trigger)) = self.inject_compaction {
            events.push(StreamEvent::System(SystemEvent {
                subtype: Some("compact_boundary".to_string()),
                session_id: Some(session_id.clone()),
                cwd: None,
                model: None,
                tools: None,
                compact_metadata: Some(CompactMetadata {
                    trigger: Some(trigger.clone()),
                    pre_tokens: Some(pre_tokens),
                }),
            }));
        }

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
                parent_tool_use_id: None,
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
            parent_tool_use_id: None,
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

    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        match &self.env_override {
            Some(env) => Ok(env.clone()),
            None => Ok(std::env::vars().collect()),
        }
    }

    async fn read_file(
        &self,
        file_path: &str,
        working_dir: &std::path::Path,
    ) -> Result<String> {
        let full_path = working_dir.join(file_path);
        Ok(tokio::fs::read_to_string(&full_path).await?)
    }

    async fn run_command(
        &self,
        _command: &str,
        _working_dir: &std::path::Path,
        _timeout: std::time::Duration,
    ) -> Result<CommandOutput> {
        self.captured_commands
            .lock()
            .unwrap()
            .push(_command.to_string());
        if self.command_results.is_empty() {
            return Ok(CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            });
        }
        let idx = self.command_call_count.fetch_add(1, Ordering::SeqCst);
        let result = &self.command_results[idx.min(self.command_results.len() - 1)];
        Ok(result.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeProvider;

    #[tokio::test]
    async fn mock_runtime_run_command_default_success() {
        let runtime = MockRuntime::completing_after(1);
        let output = runtime
            .run_command("echo hello", &std::path::PathBuf::from("/tmp"), std::time::Duration::from_secs(60))
            .await
            .expect("run_command should succeed");
        assert_eq!(output.exit_code, 0);
        assert!(output.stdout.is_empty(), "default stdout should be empty");
        assert!(output.stderr.is_empty(), "default stderr should be empty");
    }

    #[tokio::test]
    async fn mock_runtime_run_command_configured_results() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "lint failed".to_string(),
        }];

        let output = runtime
            .run_command("npm run lint", &std::path::PathBuf::from("/project"), std::time::Duration::from_secs(60))
            .await
            .expect("run_command should succeed even with non-zero exit");
        assert_eq!(output.exit_code, 1);
        assert_eq!(output.stderr, "lint failed");
    }

    #[tokio::test]
    async fn mock_runtime_run_command_cycles_results() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            CommandOutput {
                exit_code: 1,
                stdout: "first".to_string(),
                stderr: String::new(),
            },
            CommandOutput {
                exit_code: 0,
                stdout: "second".to_string(),
                stderr: String::new(),
            },
        ];

        let out1 = runtime
            .run_command("cmd", &std::path::PathBuf::from("/tmp"), std::time::Duration::from_secs(60))
            .await
            .expect("first call");
        assert_eq!(out1.exit_code, 1);
        assert_eq!(out1.stdout, "first");

        let out2 = runtime
            .run_command("cmd", &std::path::PathBuf::from("/tmp"), std::time::Duration::from_secs(60))
            .await
            .expect("second call");
        assert_eq!(out2.exit_code, 0);
        assert_eq!(out2.stdout, "second");
    }

    // ---------------------------------------------------------------
    // Tests for configurable resolve_env
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn resolve_env_no_override_returns_process_env() {
        let runtime = MockRuntime::completing_after(1);
        assert!(runtime.env_override.is_none());

        let env = runtime
            .resolve_env()
            .await
            .expect("resolve_env should succeed");

        // With no override, should return process env which always has PATH
        assert!(
            env.contains_key("PATH") || env.contains_key("Path"),
            "without env_override, resolve_env should return process env containing PATH"
        );
    }

    #[tokio::test]
    async fn resolve_env_with_override_returns_custom_map() {
        let mut runtime = MockRuntime::completing_after(1);
        let custom_env = HashMap::from([
            ("MY_VAR".to_string(), "hello".to_string()),
            ("ANOTHER".to_string(), "world".to_string()),
        ]);
        runtime.env_override = Some(custom_env.clone());

        let env = runtime
            .resolve_env()
            .await
            .expect("resolve_env should succeed");

        assert_eq!(env.len(), 2);
        assert_eq!(env.get("MY_VAR").unwrap(), "hello");
        assert_eq!(env.get("ANOTHER").unwrap(), "world");
        // Should NOT contain process env vars when override is set
        assert!(
            !env.contains_key("PATH"),
            "with env_override set, resolve_env should not include process env"
        );
    }

    #[tokio::test]
    async fn resolve_env_with_empty_override_returns_empty_map() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.env_override = Some(HashMap::new());

        let env = runtime
            .resolve_env()
            .await
            .expect("resolve_env should succeed");

        assert!(
            env.is_empty(),
            "env_override of empty map should yield empty result"
        );
    }

    #[test]
    fn env_warning_returns_none_by_default() {
        // MockRuntime does not override env_warning(), so it inherits the
        // trait default which returns None.
        let runtime = MockRuntime::completing_after(1);
        let warning = runtime.env_warning();
        assert_eq!(
            warning, None,
            "MockRuntime env_warning() should return None (trait default)"
        );
    }
}
