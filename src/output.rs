use serde::Deserialize;

/// Raw JSON response from `claude -p --output-format json`
///
/// Example:
/// ```json
/// {
///   "type": "result",
///   "subtype": "success",
///   "total_cost_usd": 0.003,
///   "is_error": false,
///   "duration_ms": 1234,
///   "duration_api_ms": 800,
///   "num_turns": 6,
///   "result": "The response text here...",
///   "session_id": "abc123"
/// }
/// ```
#[derive(Debug, Deserialize, Clone)]
pub struct ClaudeOutput {
    #[serde(rename = "type")]
    pub result_type: Option<String>,

    pub subtype: Option<String>,

    /// Total cost of this invocation in USD
    pub total_cost_usd: Option<f64>,

    /// Whether the invocation errored
    pub is_error: bool,

    /// Wall-clock duration in milliseconds
    pub duration_ms: Option<u64>,

    /// API-side duration in milliseconds
    pub duration_api_ms: Option<u64>,

    /// Number of conversation turns
    pub num_turns: Option<u32>,

    /// The actual text result from Claude
    pub result: Option<String>,

    /// Session ID for --resume support
    pub session_id: Option<String>,
}

impl ClaudeOutput {
    /// Parse JSON output from claude -p
    pub fn from_json(raw: &str) -> anyhow::Result<Self> {
        let output: ClaudeOutput = serde_json::from_str(raw)?;
        Ok(output)
    }

    /// Check if the output contains a completion signal
    pub fn has_completion_signal(&self, signal: &str) -> bool {
        self.result
            .as_ref()
            .map(|r| r.contains(signal))
            .unwrap_or(false)
    }

    /// Check if this was a successful run
    pub fn is_success(&self) -> bool {
        !self.is_error && self.subtype.as_deref() == Some("success")
    }

    /// Extract the result text, or a description of the error
    pub fn result_text(&self) -> String {
        if let Some(ref result) = self.result {
            result.clone()
        } else if self.is_error {
            format!("Error (subtype: {:?})", self.subtype)
        } else {
            "<no result>".to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_success_response() {
        let json = r#"{
            "type": "result",
            "subtype": "success",
            "total_cost_usd": 0.003,
            "is_error": false,
            "duration_ms": 1234,
            "duration_api_ms": 800,
            "num_turns": 6,
            "result": "All tasks complete. <promise>COMPLETE</promise>",
            "session_id": "abc-123"
        }"#;

        let output = ClaudeOutput::from_json(json).unwrap();
        assert!(output.is_success());
        assert!(output.has_completion_signal("<promise>COMPLETE</promise>"));
        assert_eq!(output.session_id.as_deref(), Some("abc-123"));
        assert_eq!(output.num_turns, Some(6));
    }

    #[test]
    fn parse_error_response() {
        let json = r#"{
            "type": "result",
            "subtype": "error",
            "total_cost_usd": 0.001,
            "is_error": true,
            "duration_ms": 500,
            "duration_api_ms": 200,
            "num_turns": 1,
            "result": null,
            "session_id": "abc-456"
        }"#;

        let output = ClaudeOutput::from_json(json).unwrap();
        assert!(!output.is_success());
        assert!(!output.has_completion_signal("COMPLETE"));
    }
}
