use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Events emitted by `claude -p --output-format stream-json --verbose`
///
/// Each line of stdout is one JSON object. The event types are:
/// - `system` (subtype `init`) — session metadata at startup
/// - `assistant` — a message from Claude (text, tool_use, etc.)
/// - `user` — tool results fed back (tool_result, text)
/// - `rate_limit_event` — rate limit status
/// - `result` — final summary (same shape as `--output-format json`)
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    #[serde(rename = "system")]
    System(SystemEvent),

    #[serde(rename = "assistant")]
    Assistant(AssistantEvent),

    #[serde(rename = "user")]
    User(UserEvent),

    #[serde(rename = "rate_limit_event")]
    RateLimit(RateLimitEvent),

    #[serde(rename = "result")]
    Result(ResultEvent),
}

// ── system/init ──────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SystemEvent {
    pub subtype: Option<String>,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub tools: Option<Vec<String>>,
    pub compact_metadata: Option<CompactMetadata>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CompactMetadata {
    pub trigger: Option<String>,
    pub pre_tokens: Option<u64>,
}

// ── assistant message ────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct AssistantEvent {
    pub message: AssistantMessage,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AssistantMessage {
    pub id: Option<String>,
    pub role: Option<String>,
    pub model: Option<String>,
    pub content: Vec<ContentBlock>,
    pub stop_reason: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text { text: String },

    #[serde(rename = "tool_use")]
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },

    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Usage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub cache_read_input_tokens: Option<u64>,
    pub cache_creation_input_tokens: Option<u64>,
}

// ── user (tool results) ─────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct UserEvent {
    pub message: Option<serde_json::Value>,
    pub session_id: Option<String>,
}

// ── rate limit ───────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitEvent {
    pub rate_limit_info: Option<RateLimitInfo>,
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RateLimitInfo {
    pub status: Option<String>,
    #[serde(rename = "rateLimitType")]
    pub rate_limit_type: Option<String>,
    #[serde(rename = "resetsAt")]
    pub resets_at: Option<u64>,
}

// ── token usage ─────────────────────────────────────────────

/// Aggregate token usage for a single `claude -p` invocation
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
}

/// Per-model token usage breakdown (from `modelUsage` in result)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelTokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cost_usd: f64,
    pub context_window: u64,
    pub max_output_tokens: u64,
}

// ── result (final) ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResultEvent {
    pub subtype: Option<String>,
    pub is_error: bool,
    pub duration_ms: Option<u64>,
    pub duration_api_ms: Option<u64>,
    pub num_turns: Option<u32>,
    pub result: Option<String>,
    pub session_id: Option<String>,
    pub total_cost_usd: Option<f64>,
    pub stop_reason: Option<String>,
    pub usage: Option<serde_json::Value>,
    #[serde(rename = "modelUsage")]
    pub model_usage: Option<HashMap<String, serde_json::Value>>,
}

impl ResultEvent {
    pub fn has_completion_signal(&self, signal: &str) -> bool {
        self.result
            .as_ref()
            .is_some_and(|r| r.contains(signal))
    }

    pub fn is_success(&self) -> bool {
        !self.is_error && self.subtype.as_deref() == Some("success")
    }

    pub fn result_text(&self) -> String {
        if let Some(ref result) = self.result {
            result.clone()
        } else if self.is_error {
            format!("Error (subtype: {:?})", self.subtype)
        } else {
            "<no result>".to_string()
        }
    }

    /// Extract aggregate token usage from the `usage` field
    pub fn token_usage(&self) -> TokenUsage {
        let Some(ref v) = self.usage else {
            return TokenUsage::default();
        };
        TokenUsage {
            input_tokens: v["input_tokens"].as_u64().unwrap_or(0),
            output_tokens: v["output_tokens"].as_u64().unwrap_or(0),
            cache_read_input_tokens: v["cache_read_input_tokens"].as_u64().unwrap_or(0),
            cache_creation_input_tokens: v["cache_creation_input_tokens"].as_u64().unwrap_or(0),
        }
    }

    /// Extract per-model token usage from the `modelUsage` field
    pub fn model_token_usage(&self) -> HashMap<String, ModelTokenUsage> {
        let Some(ref mu) = self.model_usage else {
            return HashMap::new();
        };
        mu.iter()
            .filter_map(|(model, v)| {
                Some((
                    model.clone(),
                    ModelTokenUsage {
                        input_tokens: v["inputTokens"].as_u64().unwrap_or(0),
                        output_tokens: v["outputTokens"].as_u64().unwrap_or(0),
                        cache_read_input_tokens: v["cacheReadInputTokens"].as_u64().unwrap_or(0),
                        cache_creation_input_tokens: v["cacheCreationInputTokens"]
                            .as_u64()
                            .unwrap_or(0),
                        cost_usd: v["costUSD"].as_f64().unwrap_or(0.0),
                        context_window: v["contextWindow"].as_u64().unwrap_or(0),
                        max_output_tokens: v["maxOutputTokens"].as_u64().unwrap_or(0),
                    },
                ))
            })
            .collect()
    }
}

// ── Parsing ──────────────────────────────────────────────────

impl StreamEvent {
    /// Parse a single line of stream-json output.
    pub fn parse_line(line: &str) -> anyhow::Result<Self> {
        let event: StreamEvent = serde_json::from_str(line)?;
        Ok(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_system_init() {
        let json = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc","model":"claude-opus-4-6","tools":["Bash","Read"]}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::System(e) => {
                assert_eq!(e.subtype.as_deref(), Some("init"));
                assert_eq!(e.model.as_deref(), Some("claude-opus-4-6"));
            }
            _ => panic!("expected System event"),
        }
    }

    #[test]
    fn parse_assistant_text() {
        let json = r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"hello"}],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}},"session_id":"abc"}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Assistant(e) => {
                assert_eq!(e.message.content.len(), 1);
                match &e.message.content[0] {
                    ContentBlock::Text { text } => assert_eq!(text, "hello"),
                    _ => panic!("expected text block"),
                }
            }
            _ => panic!("expected Assistant event"),
        }
    }

    #[test]
    fn parse_assistant_tool_use() {
        let json = r#"{"type":"assistant","message":{"id":"msg_2","role":"assistant","model":"claude-opus-4-6","content":[{"type":"tool_use","id":"toolu_123","name":"Read","input":{"file_path":"/tmp/foo"}}],"stop_reason":null,"usage":null},"session_id":"abc"}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Assistant(e) => {
                match &e.message.content[0] {
                    ContentBlock::ToolUse { name, .. } => assert_eq!(name, "Read"),
                    _ => panic!("expected tool_use block"),
                }
            }
            _ => panic!("expected Assistant event"),
        }
    }

    #[test]
    fn parse_result_success() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","stop_reason":"end_turn","session_id":"abc","total_cost_usd":0.041}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                assert!(r.is_success());
                assert_eq!(r.result.as_deref(), Some("hello"));
                assert!(!r.has_completion_signal("COMPLETE"));
                assert!(r.has_completion_signal("hello"));
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn parse_rate_limit() {
        let json = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1772845200,"rateLimitType":"five_hour"},"session_id":"abc"}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::RateLimit(e) => {
                let info = e.rate_limit_info.unwrap();
                assert_eq!(info.status.as_deref(), Some("allowed"));
            }
            _ => panic!("expected RateLimit event"),
        }
    }

    #[test]
    fn parse_result_with_completion_signal() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":5000,"duration_api_ms":4500,"num_turns":6,"result":"All done. <promise>COMPLETE</promise>","session_id":"abc","total_cost_usd":0.12}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                assert!(r.has_completion_signal("<promise>COMPLETE</promise>"));
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn parse_real_cli_system_init() {
        // Captured from actual `claude -p --output-format stream-json --verbose`
        let json = r#"{"type":"system","subtype":"init","cwd":"/home/beth/repos/yarr","session_id":"56d92692-1c8a-46a9-83b1-b1365b8c770d","tools":["Bash","Read","Write"],"mcp_servers":[{"name":"posthog","status":"needs-auth"}],"model":"claude-opus-4-6","permissionMode":"acceptEdits","slash_commands":["simplify"],"apiKeySource":"none","claude_code_version":"2.1.70","output_style":"default","agents":["general-purpose"],"skills":["simplify"],"plugins":[],"uuid":"5616c975-5668-4911-8300-255db19a951a","fast_mode_state":"off"}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::System(e) => {
                assert_eq!(e.subtype.as_deref(), Some("init"));
                assert_eq!(e.model.as_deref(), Some("claude-opus-4-6"));
                assert_eq!(
                    e.session_id.as_deref(),
                    Some("56d92692-1c8a-46a9-83b1-b1365b8c770d")
                );
            }
            _ => panic!("expected System event"),
        }
    }

    #[test]
    fn parse_real_cli_result() {
        // Captured from actual CLI output with modelUsage and full usage fields
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","stop_reason":"end_turn","session_id":"56d92692-1c8a-46a9-83b1-b1365b8c770d","total_cost_usd":0.04098374999999999,"usage":{"input_tokens":3,"cache_creation_input_tokens":6539,"cache_read_input_tokens":0,"output_tokens":4,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":6539,"ephemeral_5m_input_tokens":0},"inference_geo":"","iterations":[],"speed":"standard"},"modelUsage":{"claude-opus-4-6":{"inputTokens":3,"outputTokens":4,"cacheReadInputTokens":0,"cacheCreationInputTokens":6539,"webSearchRequests":0,"costUSD":0.04098374999999999,"contextWindow":200000,"maxOutputTokens":32000}},"permission_denials":[],"fast_mode_state":"off","uuid":"6f314b1b-df9f-4678-982b-58f2fb7db3b5"}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                assert!(r.is_success());
                assert_eq!(r.result.as_deref(), Some("hello"));
                assert!((r.total_cost_usd.unwrap() - 0.041).abs() < 0.001);
                assert!(r.model_usage.is_some());
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn token_usage_from_real_result() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","stop_reason":"end_turn","session_id":"abc","total_cost_usd":0.041,"usage":{"input_tokens":3,"cache_creation_input_tokens":6539,"cache_read_input_tokens":0,"output_tokens":4}}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                let usage = r.token_usage();
                assert_eq!(usage.input_tokens, 3);
                assert_eq!(usage.output_tokens, 4);
                assert_eq!(usage.cache_read_input_tokens, 0);
                assert_eq!(usage.cache_creation_input_tokens, 6539);
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn token_usage_defaults_when_missing() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"num_turns":1,"result":"ok","session_id":"abc","total_cost_usd":0.01}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                let usage = r.token_usage();
                assert_eq!(usage.input_tokens, 0);
                assert_eq!(usage.output_tokens, 0);
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn model_token_usage_from_real_result() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","stop_reason":"end_turn","session_id":"abc","total_cost_usd":0.041,"modelUsage":{"claude-opus-4-6":{"inputTokens":3,"outputTokens":4,"cacheReadInputTokens":0,"cacheCreationInputTokens":6539,"costUSD":0.041,"contextWindow":200000,"maxOutputTokens":32000}}}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                let mu = r.model_token_usage();
                assert_eq!(mu.len(), 1);
                let opus = &mu["claude-opus-4-6"];
                assert_eq!(opus.input_tokens, 3);
                assert_eq!(opus.output_tokens, 4);
                assert_eq!(opus.cache_creation_input_tokens, 6539);
                assert_eq!(opus.context_window, 200000);
                assert_eq!(opus.max_output_tokens, 32000);
                assert!((opus.cost_usd - 0.041).abs() < 0.001);
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn model_token_usage_empty_when_missing() {
        let json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":100,"num_turns":1,"result":"ok","session_id":"abc","total_cost_usd":0.01}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::Result(r) => {
                assert!(r.model_token_usage().is_empty());
            }
            _ => panic!("expected Result event"),
        }
    }

    #[test]
    fn parse_compact_boundary() {
        let json = r#"{"type":"system","subtype":"compact_boundary","compact_metadata":{"trigger":"auto","pre_tokens":167000}}"#;
        let event = StreamEvent::parse_line(json).unwrap();
        match event {
            StreamEvent::System(e) => {
                assert_eq!(e.subtype.as_deref(), Some("compact_boundary"));
                assert!(e.compact_metadata.is_some());
                let meta = e.compact_metadata.unwrap();
                assert_eq!(meta.trigger, Some("auto".to_string()));
                assert_eq!(meta.pre_tokens, Some(167000));
            }
            _ => panic!("expected System event"),
        }
    }
}
