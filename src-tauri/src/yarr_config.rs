use std::collections::HashMap;

use serde::Deserialize;

use crate::session::{Check, GitSyncConfig};

#[derive(Debug, Clone, serde::Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct YarrRepoConfig {
    pub model: Option<String>,
    pub effort_level: Option<String>,
    pub design_effort_level: Option<String>,
    pub max_iterations: Option<u32>,
    pub completion_signal: Option<String>,
    pub create_branch: Option<bool>,
    pub auto_fetch: Option<bool>,
    pub plans_dir: Option<String>,
    pub move_plans_to_completed: Option<bool>,
    pub design_prompt_file: Option<String>,
    pub implementation_prompt_file: Option<String>,
    pub env: Option<HashMap<String, String>>,
    pub checks: Option<Vec<Check>>,
    pub git_sync: Option<GitSyncConfig>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct YarrConfigResult {
    pub config: Option<YarrRepoConfig>,
    pub error: Option<String>,
}

pub fn parse(yaml: &str) -> anyhow::Result<YarrRepoConfig> {
    let config: YarrRepoConfig = serde_yaml::from_str(yaml)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::CheckWhen;

    #[test]
    fn valid_full_yaml() {
        let yaml = r#"
model: "claude-sonnet-4-20250514"
effortLevel: "high"
designEffortLevel: "medium"
maxIterations: 10
completionSignal: "<done>COMPLETE</done>"
createBranch: true
autoFetch: true
plansDir: "plans"
movePlansToCompleted: true
designPromptFile: "prompts/design.md"
implementationPromptFile: "prompts/impl.md"
env:
  RUST_LOG: debug
  NODE_ENV: test
checks:
  - name: "lint"
    command: "npm run lint"
    when: each_iteration
    prompt: "Fix lint errors"
    model: "claude-sonnet-4-20250514"
    timeoutSecs: 300
    maxRetries: 2
  - name: "test"
    command: "cargo test"
    when: post_completion
    timeoutSecs: 600
    maxRetries: 1
gitSync:
  enabled: true
  conflictPrompt: "Resolve merge conflicts"
  model: "claude-sonnet-4-20250514"
  maxPushRetries: 5
"#;
        let config = parse(yaml).expect("should parse valid full YAML");

        assert_eq!(config.model.as_deref(), Some("claude-sonnet-4-20250514"));
        assert_eq!(config.effort_level.as_deref(), Some("high"));
        assert_eq!(config.design_effort_level.as_deref(), Some("medium"));
        assert_eq!(config.max_iterations, Some(10));
        assert_eq!(
            config.completion_signal.as_deref(),
            Some("<done>COMPLETE</done>")
        );
        assert_eq!(config.create_branch, Some(true));
        assert_eq!(config.auto_fetch, Some(true));
        assert_eq!(config.plans_dir.as_deref(), Some("plans"));
        assert_eq!(config.move_plans_to_completed, Some(true));
        assert_eq!(
            config.design_prompt_file.as_deref(),
            Some("prompts/design.md")
        );
        assert_eq!(
            config.implementation_prompt_file.as_deref(),
            Some("prompts/impl.md")
        );

        let env = config.env.as_ref().unwrap();
        assert_eq!(env.get("RUST_LOG").unwrap(), "debug");
        assert_eq!(env.get("NODE_ENV").unwrap(), "test");

        let checks = config.checks.as_ref().unwrap();
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].name, "lint");
        assert_eq!(checks[1].name, "test");

        let git_sync = config.git_sync.as_ref().unwrap();
        assert!(git_sync.enabled);
        assert_eq!(
            git_sync.conflict_prompt.as_deref(),
            Some("Resolve merge conflicts")
        );
        assert_eq!(git_sync.max_push_retries, 5);
    }

    #[test]
    fn partial_yaml() {
        let yaml = r#"
model: "claude-sonnet-4-20250514"
maxIterations: 5
"#;
        let config = parse(yaml).expect("should parse partial YAML");

        assert_eq!(config.model.as_deref(), Some("claude-sonnet-4-20250514"));
        assert_eq!(config.max_iterations, Some(5));
        assert!(config.effort_level.is_none());
        assert!(config.design_effort_level.is_none());
        assert!(config.completion_signal.is_none());
        assert!(config.create_branch.is_none());
        assert!(config.auto_fetch.is_none());
        assert!(config.plans_dir.is_none());
        assert!(config.move_plans_to_completed.is_none());
        assert!(config.design_prompt_file.is_none());
        assert!(config.implementation_prompt_file.is_none());
        assert!(config.env.is_none());
        assert!(config.checks.is_none());
        assert!(config.git_sync.is_none());
    }

    #[test]
    fn empty_string_parses_to_default() {
        let config = parse("").expect("empty string should parse");

        assert!(config.model.is_none());
        assert!(config.max_iterations.is_none());
        assert!(config.checks.is_none());
        assert!(config.git_sync.is_none());
        assert!(config.env.is_none());
    }

    #[test]
    fn malformed_yaml_returns_error() {
        let yaml = r#"
model: [invalid
  : broken yaml {{{}
"#;
        let result = parse(yaml);
        assert!(result.is_err(), "malformed YAML should return an error");
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let yaml = r#"
model: "claude-sonnet-4-20250514"
someUnknownField: "should be ignored"
anotherUnknownField: 42
"#;
        let config = parse(yaml).expect("unknown fields should be ignored");
        assert_eq!(config.model.as_deref(), Some("claude-sonnet-4-20250514"));
    }

    #[test]
    fn checks_with_camel_case() {
        let yaml = r#"
checks:
  - name: "typecheck"
    command: "npx tsc --noEmit"
    when: each_iteration
    timeoutSecs: 120
    maxRetries: 5
"#;
        let config = parse(yaml).expect("should parse checks with camelCase");
        let checks = config.checks.unwrap();
        assert_eq!(checks.len(), 1);

        let check = &checks[0];
        assert_eq!(check.name, "typecheck");
        assert_eq!(check.command, "npx tsc --noEmit");
        assert_eq!(check.when, CheckWhen::EachIteration);
        assert_eq!(check.timeout_secs, 120);
        assert_eq!(check.max_retries, 5);
        assert!(check.prompt.is_none());
        assert!(check.model.is_none());
    }

    #[test]
    fn checks_default_timeout_and_retries() {
        let yaml = r#"
checks:
  - name: "build"
    command: "cargo build"
    when: post_completion
"#;
        let config = parse(yaml).expect("should parse checks with defaults");
        let check = &config.checks.unwrap()[0];
        assert_eq!(check.timeout_secs, 1200, "default timeout should be 1200");
        assert_eq!(check.max_retries, 3, "default max_retries should be 3");
    }

    #[test]
    fn env_as_hashmap() {
        let yaml = r#"
env:
  RUST_LOG: "info"
  DATABASE_URL: "postgres://localhost/test"
  ENABLE_FEATURE: "true"
"#;
        let config = parse(yaml).expect("should parse env as HashMap");
        let env = config.env.unwrap();
        assert_eq!(env.len(), 3);
        assert_eq!(env.get("RUST_LOG").unwrap(), "info");
        assert_eq!(
            env.get("DATABASE_URL").unwrap(),
            "postgres://localhost/test"
        );
        assert_eq!(env.get("ENABLE_FEATURE").unwrap(), "true");
    }

    #[test]
    fn git_sync_nested_object() {
        let yaml = r#"
gitSync:
  enabled: true
  conflictPrompt: "Please resolve the merge conflicts"
  model: "claude-sonnet-4-20250514"
  maxPushRetries: 7
"#;
        let config = parse(yaml).expect("should parse gitSync");
        let git_sync = config.git_sync.unwrap();
        assert!(git_sync.enabled);
        assert_eq!(
            git_sync.conflict_prompt.as_deref(),
            Some("Please resolve the merge conflicts")
        );
        assert_eq!(git_sync.model.as_deref(), Some("claude-sonnet-4-20250514"));
        assert_eq!(git_sync.max_push_retries, 7);
    }

    #[test]
    fn git_sync_defaults() {
        let yaml = r#"
gitSync:
  enabled: false
"#;
        let config = parse(yaml).expect("should parse gitSync with defaults");
        let git_sync = config.git_sync.unwrap();
        assert!(!git_sync.enabled);
        assert!(git_sync.conflict_prompt.is_none());
        assert!(git_sync.model.is_none());
        assert_eq!(git_sync.max_push_retries, 3, "default max_push_retries should be 3");
    }

    #[test]
    fn config_result_with_config_present() {
        let config = parse("model: \"opus\"\nmaxIterations: 5\n").unwrap();
        let result = YarrConfigResult {
            config: Some(config),
            error: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["error"], serde_json::Value::Null);
        let cfg = &json["config"];
        assert_eq!(cfg["model"], "opus");
        assert_eq!(cfg["maxIterations"], 5);
        // Fields not set in YAML should serialize as null
        assert_eq!(cfg["effortLevel"], serde_json::Value::Null);
    }

    #[test]
    fn config_result_with_error_no_config() {
        let result = YarrConfigResult {
            config: None,
            error: Some("parse error: invalid YAML at line 3".to_string()),
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["config"], serde_json::Value::Null);
        assert_eq!(json["error"], "parse error: invalid YAML at line 3");
    }

    #[test]
    fn config_result_both_none() {
        let result = YarrConfigResult {
            config: None,
            error: None,
        };
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["config"], serde_json::Value::Null);
        assert_eq!(json["error"], serde_json::Value::Null);
    }

    #[test]
    fn repo_config_round_trip_yaml_to_json() {
        let yaml = r#"
model: "claude-sonnet-4-20250514"
maxIterations: 8
createBranch: true
env:
  RUST_LOG: debug
checks:
  - name: "lint"
    command: "npm run lint"
    when: each_iteration
gitSync:
  enabled: true
  maxPushRetries: 4
"#;
        let config = parse(yaml).unwrap();
        let json = serde_json::to_value(&config).unwrap();

        assert_eq!(json["model"], "claude-sonnet-4-20250514");
        assert_eq!(json["maxIterations"], 8);
        assert_eq!(json["createBranch"], true);
        assert_eq!(json["env"]["RUST_LOG"], "debug");

        let checks = json["checks"].as_array().unwrap();
        assert_eq!(checks.len(), 1);
        assert_eq!(checks[0]["name"], "lint");

        let git_sync = &json["gitSync"];
        assert_eq!(git_sync["enabled"], true);
        assert_eq!(git_sync["maxPushRetries"], 4);
    }
}
