pub mod oneshot;
pub mod output;
pub mod prompt;
pub mod runtime;
pub mod session;
pub mod ssh_orchestrator;
pub mod trace;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use oneshot::OneShotRunner;
use runtime::{default_runtime, MockRuntime, SshRuntime};
use session::{SessionConfig, SessionEvent, SessionRunner};
use ssh_orchestrator::SshSessionOrchestrator;
use tauri::{Emitter, Manager, RunEvent};
use trace::TraceCollector;

/// Wraps a `SessionEvent` with a `repo_id` so the frontend can demux events
/// from concurrent sessions running against different repositories.
#[derive(serde::Serialize, Clone)]
pub(crate) struct TaggedSessionEvent {
    repo_id: String,
    event: SessionEvent,
}

/// Shared state tracking cancellation tokens for all active sessions, keyed by repo_id
struct ActiveSessions {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

/// Shared abort registry for child processes. On app exit, all handles are aborted
/// to kill processes that wouldn't die from token cancellation alone
/// (e.g. WSL processes where killing wsl.exe doesn't kill the Linux-side claude).
struct GlobalAbortRegistry {
    inner: session::AbortRegistry,
}

struct ActiveSshSessions {
    sessions: std::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Notify>>>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum RepoType {
    Local { path: String },
    #[serde(rename_all = "camelCase")]
    Ssh { ssh_host: String, remote_path: String },
}

#[tauri::command]
async fn run_mock_session(app: tauri::AppHandle, repo_id: String) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.insert(repo_id.clone(), cancel_token.clone());
    }

    let runtime = MockRuntime::completing_after(3);

    let config = SessionConfig {
        repo_path: PathBuf::from("/mock/project"),
        prompt: "Mock prompt: implement tasks and signal completion.".to_string(),
        max_iterations: 10,
        completion_signal: "<promise>COMPLETE</promise>".to_string(),
        model: None,
        extra_args: vec![],
        plan_file: None,
        inter_iteration_delay_ms: 100,
        env_vars: HashMap::new(),
        checks: Vec::new(),
        git_sync: None,
    };

    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let collector = TraceCollector::new(base_dir, &repo_id);

    let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
    let app_handle = app.clone();
    let repo_id_clone = repo_id.clone();
    let runner = SessionRunner::new(config, collector, cancel_token)
        .abort_registry(abort_registry)
        .on_event(Box::new(move |event| {
            let _ = app_handle.emit("session-event", TaggedSessionEvent {
                repo_id: repo_id_clone.clone(),
                event: event.clone(),
            });
        }));

    let result = runner.run(&runtime).await.map_err(|e| e.to_string());
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.remove(&repo_id);
    }
    result
}

#[tauri::command]
async fn run_session(
    app: tauri::AppHandle,
    repo_id: String,
    repo: RepoType,
    plan_file: String,
    model: String,
    max_iterations: u32,
    completion_signal: String,
    env_vars: Option<HashMap<String, String>>,
    checks: Option<Vec<session::Check>>,
) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.insert(repo_id.clone(), cancel_token.clone());
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);
            let runtime = default_runtime();

            // Resolve plan file to absolute path for the @file reference
            let plan_path = {
                let p = Path::new(&plan_file);
                if p.is_relative() {
                    repo_path_buf.join(p)
                } else {
                    p.to_path_buf()
                }
            };

            // Verify plan file exists before building prompt
            if !plan_path.exists() {
                app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                return Err(format!("Plan file not found: {}", plan_path.display()));
            }

            let prompt = prompt::build_prompt(&plan_path.to_string_lossy());

            let config = SessionConfig {
                repo_path: repo_path_buf,
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync: None,
            };

            let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let collector = TraceCollector::new(base_dir, &repo_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let repo_id_clone = repo_id.clone();
            let runner = SessionRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    let _ = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: repo_id_clone.clone(),
                        event: event.clone(),
                    });
                }));

            let result = runner.run(runtime.as_ref()).await.map_err(|e| e.to_string());
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
            result
        }
        RepoType::Ssh { ssh_host, remote_path } => {
            let ssh_runtime = SshRuntime::new(ssh_host, remote_path);

            let plan_path = {
                let p = std::path::Path::new(&plan_file);
                if !p.is_absolute() {
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                    return Err("Plan file must be an absolute path for SSH repos".to_string());
                }
                p.to_path_buf()
            };

            // We can't verify the plan file exists on remote, skip the check
            let prompt = prompt::build_prompt(&plan_path.to_string_lossy());

            let config = SessionConfig {
                repo_path: PathBuf::from(remote_path),
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync: None,
            };

            let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let collector = TraceCollector::new(base_dir, &repo_id);

            let orchestrator = SshSessionOrchestrator::new(
                ssh_runtime,
                config,
                collector,
                cancel_token.clone(),
            );

            // Store reconnect handle
            let reconnect_notify = orchestrator.reconnect_notify();
            {
                let ssh_sessions = app.state::<ActiveSshSessions>();
                ssh_sessions.sessions.lock().unwrap().insert(repo_id.clone(), reconnect_notify);
            }

            let app_handle = app.clone();
            let repo_id_clone = repo_id.clone();
            let orchestrator = orchestrator.on_event(Box::new(move |event| {
                let _ = app_handle.emit("session-event", TaggedSessionEvent {
                    repo_id: repo_id_clone.clone(),
                    event: event.clone(),
                });
            }));

            let result = orchestrator.run().await.map_err(|e| e.to_string());

            // Clean up
            {
                let ssh_sessions = app.state::<ActiveSshSessions>();
                ssh_sessions.sessions.lock().unwrap().remove(&repo_id);
            }
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
            result
        }
    }
}

#[tauri::command]
async fn run_oneshot(
    app: tauri::AppHandle,
    repo_id: String,
    repo: RepoType,
    title: String,
    prompt: String,
    model: String,
    merge_strategy: oneshot::MergeStrategy,
    env_vars: Option<HashMap<String, String>>,
) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.insert(repo_id.clone(), cancel_token.clone());
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);
            let runtime = default_runtime();

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: repo_path_buf,
                title,
                prompt,
                model,
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
            };

            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                    return Err(e.to_string());
                }
            };
            let collector = TraceCollector::new(base_dir, &repo_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let repo_id_clone = repo_id.clone();
            let runner = OneShotRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    let _ = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: repo_id_clone.clone(),
                        event: event.clone(),
                    });
                }));

            let result = runner.run(runtime.as_ref()).await.map_err(|e| e.to_string());
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
            result
        }
        RepoType::Ssh { .. } => {
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
            Err("1-shot is not supported for SSH repos".to_string())
        }
    }
}

#[tauri::command]
fn list_traces(app: tauri::AppHandle, repo_id: Option<String>) -> Result<Vec<trace::SessionTrace>, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::list_traces(&base_dir, repo_id.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_latest_traces(app: tauri::AppHandle) -> Result<Vec<trace::SessionTrace>, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::list_latest_traces(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trace(app: tauri::AppHandle, repo_id: String, session_id: String) -> Result<trace::SessionTrace, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::read_trace(&base_dir, &repo_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trace_events(app: tauri::AppHandle, repo_id: String, session_id: String) -> Result<Vec<session::SessionEvent>, String> {
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::read_events(&base_dir, &repo_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_preview(path: String, max_lines: Option<u32>) -> Result<String, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let limit = max_lines.unwrap_or(5) as usize;
    let result: String = content.lines().take(limit).collect::<Vec<_>>().join("\n");
    Ok(result)
}

#[tauri::command]
async fn get_active_sessions(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let active = app.state::<ActiveSessions>();
    let repo_ids: Vec<String> = active.tokens.lock().await.keys().cloned().collect();
    Ok(repo_ids)
}

#[tauri::command]
async fn stop_session(app: tauri::AppHandle, repo_id: String) -> Result<(), String> {
    let active = app.state::<ActiveSessions>();
    let tokens = active.tokens.lock().await;
    if let Some(token) = tokens.get(&repo_id) {
        token.cancel();
        Ok(())
    } else {
        Err("No active session to stop".to_string())
    }
}

#[tauri::command]
async fn test_ssh_connection(ssh_host: String) -> Result<String, String> {
    let rt = SshRuntime::new(&ssh_host, "");
    use runtime::RuntimeProvider;
    rt.health_check().await.map_err(|e| e.to_string())?;
    Ok("Connection successful: tmux and claude are available".to_string())
}

#[tauri::command]
async fn reconnect_session(app: tauri::AppHandle, repo_id: String) -> Result<(), String> {
    let ssh_sessions = app.state::<ActiveSshSessions>();
    let notify = {
        let guard = ssh_sessions.sessions.lock().unwrap();
        guard.get(&repo_id).cloned()
    };
    match notify {
        Some(n) => {
            n.notify_one();
            Ok(())
        }
        None => Err(format!("No active SSH session for repo {repo_id}"))
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        })
        .manage(ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .manage(GlobalAbortRegistry {
            inner: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        })
        .invoke_handler(tauri::generate_handler![run_mock_session, run_session, run_oneshot, stop_session, get_active_sessions, test_ssh_connection, reconnect_session, list_traces, list_latest_traces, get_trace, get_trace_events, read_file_preview])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Cancel all cancellation tokens
                let active = app.state::<ActiveSessions>();
                if let Ok(guard) = active.tokens.try_lock() {
                    for (repo_id, token) in guard.iter() {
                        tracing::info!("Cancelling session for repo {repo_id} on exit");
                        token.cancel();
                    }
                }
                // Directly abort all child processes (kills WSL-side processes too)
                let registry = app.state::<GlobalAbortRegistry>();
                let handles = registry.inner.lock().unwrap();
                for handle in handles.iter() {
                    handle.abort();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use session::SessionEvent;
    use trace::SessionOutcome;

    #[test]
    fn tagged_session_event_serializes_correctly() {
        let event = TaggedSessionEvent {
            repo_id: "repo-abc".to_string(),
            event: SessionEvent::SessionStarted {
                session_id: "sess-123".to_string(),
            },
        };

        let json = serde_json::to_value(&event).expect("serialization should succeed");

        assert_eq!(json["repo_id"], "repo-abc");
        assert_eq!(json["event"]["kind"], "session_started");
        assert_eq!(json["event"]["session_id"], "sess-123");
    }

    #[test]
    fn tagged_session_event_preserves_repo_id() {
        let event_a = TaggedSessionEvent {
            repo_id: "repo-alpha".to_string(),
            event: SessionEvent::SessionStarted {
                session_id: "sess-1".to_string(),
            },
        };
        let event_b = TaggedSessionEvent {
            repo_id: "repo-beta".to_string(),
            event: SessionEvent::SessionStarted {
                session_id: "sess-2".to_string(),
            },
        };

        let json_a = serde_json::to_value(&event_a).expect("serialization should succeed");
        let json_b = serde_json::to_value(&event_b).expect("serialization should succeed");

        assert_eq!(json_a["repo_id"], "repo-alpha");
        assert_eq!(json_b["repo_id"], "repo-beta");
        assert_ne!(json_a["repo_id"], json_b["repo_id"]);
    }

    #[test]
    fn tagged_session_event_clone_produces_equal_json() {
        let event = TaggedSessionEvent {
            repo_id: "repo-xyz".to_string(),
            event: SessionEvent::SessionComplete {
                outcome: SessionOutcome::Completed,
            },
        };

        let cloned = event.clone();

        let json_original =
            serde_json::to_string(&event).expect("serialization should succeed");
        let json_cloned =
            serde_json::to_string(&cloned).expect("serialization should succeed");

        assert_eq!(json_original, json_cloned);
    }

    #[test]
    fn repo_type_local_deserializes_from_json() {
        let json = r#"{ "type": "local", "path": "/some/path" }"#;
        let repo: RepoType = serde_json::from_str(json).expect("deserialization should succeed");
        match repo {
            RepoType::Local { path } => assert_eq!(path, "/some/path"),
            other => panic!("expected RepoType::Local, got {:?}", other),
        }
    }

    #[test]
    fn repo_type_ssh_deserializes_from_json() {
        let json = r#"{ "type": "ssh", "sshHost": "user@host", "remotePath": "/repo/path" }"#;
        let repo: RepoType = serde_json::from_str(json).expect("deserialization should succeed");
        match repo {
            RepoType::Ssh { ssh_host, remote_path } => {
                assert_eq!(ssh_host, "user@host");
                assert_eq!(remote_path, "/repo/path");
            }
            other => panic!("expected RepoType::Ssh, got {:?}", other),
        }
    }

    #[test]
    fn repo_type_unknown_type_fails() {
        let json = r#"{ "type": "unknown" }"#;
        let result = serde_json::from_str::<RepoType>(json);
        assert!(result.is_err(), "deserializing an unknown type tag should fail");
    }

    #[test]
    fn repo_type_local_missing_path_fails() {
        let json = r#"{ "type": "local" }"#;
        let result = serde_json::from_str::<RepoType>(json);
        assert!(result.is_err(), "deserializing local without path should fail");
    }

    #[test]
    fn repo_type_ssh_missing_fields_fails() {
        let json = r#"{ "type": "ssh", "sshHost": "host" }"#;
        let result = serde_json::from_str::<RepoType>(json);
        assert!(result.is_err(), "deserializing ssh without remotePath should fail");
    }

    // --- ActiveSshSessions state management tests ---

    #[test]
    fn test_active_ssh_sessions_insert_and_get() {
        let state = ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        state.sessions.lock().unwrap().insert("repo-1".to_string(), notify.clone());

        let guard = state.sessions.lock().unwrap();
        let retrieved = guard.get("repo-1");
        assert!(retrieved.is_some(), "should find the inserted repo-1 handle");
        assert!(std::sync::Arc::ptr_eq(retrieved.unwrap(), &notify));
    }

    #[test]
    fn test_active_ssh_sessions_missing_repo() {
        let state = ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        };

        let guard = state.sessions.lock().unwrap();
        let retrieved = guard.get("nonexistent");
        assert!(retrieved.is_none(), "looking up a missing repo should return None");
    }

    #[test]
    fn test_active_ssh_sessions_remove() {
        let state = ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        state.sessions.lock().unwrap().insert("repo-1".to_string(), notify);

        // Remove the entry
        let removed = state.sessions.lock().unwrap().remove("repo-1");
        assert!(removed.is_some(), "remove should return the previously inserted handle");

        // Verify it is gone
        let guard = state.sessions.lock().unwrap();
        assert!(guard.get("repo-1").is_none(), "repo-1 should no longer be present after removal");
    }

    #[test]
    fn test_active_ssh_sessions_multiple_repos() {
        let state = ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        };
        let notify_a = std::sync::Arc::new(tokio::sync::Notify::new());
        let notify_b = std::sync::Arc::new(tokio::sync::Notify::new());
        let notify_c = std::sync::Arc::new(tokio::sync::Notify::new());

        {
            let mut guard = state.sessions.lock().unwrap();
            guard.insert("repo-a".to_string(), notify_a.clone());
            guard.insert("repo-b".to_string(), notify_b.clone());
            guard.insert("repo-c".to_string(), notify_c.clone());
        }

        let guard = state.sessions.lock().unwrap();
        assert!(std::sync::Arc::ptr_eq(guard.get("repo-a").unwrap(), &notify_a));
        assert!(std::sync::Arc::ptr_eq(guard.get("repo-b").unwrap(), &notify_b));
        assert!(std::sync::Arc::ptr_eq(guard.get("repo-c").unwrap(), &notify_c));
        assert_eq!(guard.len(), 3);
    }

    #[tokio::test]
    async fn test_reconnect_notify_signals_waiter() {
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let notify_clone = notify.clone();

        // Spawn a task that waits for the notification
        let waiter = tokio::spawn(async move {
            notify_clone.notified().await;
            true
        });

        // Signal the waiter
        notify.notify_one();

        // The waiter should complete promptly
        let result = tokio::time::timeout(std::time::Duration::from_secs(2), waiter)
            .await
            .expect("waiter should complete within timeout")
            .expect("spawned task should not panic");

        assert!(result, "waiter should have received the notification and returned true");
    }

    #[test]
    fn read_file_preview_returns_first_n_lines() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().expect("failed to create temp file");
        for i in 1..=10 {
            writeln!(file, "line {}", i).expect("failed to write");
        }
        let path = file.path().to_string_lossy().to_string();

        let result = read_file_preview(path, Some(3)).expect("should return Ok");
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], "line 1");
        assert_eq!(lines[2], "line 3");
    }

    #[test]
    fn read_file_preview_defaults_to_five_lines() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().expect("failed to create temp file");
        for i in 1..=10 {
            writeln!(file, "line {}", i).expect("failed to write");
        }
        let path = file.path().to_string_lossy().to_string();

        let result = read_file_preview(path, None).expect("should return Ok");
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0], "line 1");
        assert_eq!(lines[4], "line 5");
    }

    #[test]
    fn read_file_preview_returns_all_when_fewer_than_max() {
        use std::io::Write;
        let mut file = tempfile::NamedTempFile::new().expect("failed to create temp file");
        writeln!(file, "first").expect("failed to write");
        writeln!(file, "second").expect("failed to write");
        let path = file.path().to_string_lossy().to_string();

        let result = read_file_preview(path, Some(5)).expect("should return Ok");
        let lines: Vec<&str> = result.lines().collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "first");
        assert_eq!(lines[1], "second");
    }

    #[test]
    fn read_file_preview_empty_file() {
        let file = tempfile::NamedTempFile::new().expect("failed to create temp file");
        let path = file.path().to_string_lossy().to_string();

        let result = read_file_preview(path, None).expect("should return Ok");
        assert_eq!(result, "");
    }

    #[test]
    fn read_file_preview_nonexistent_file() {
        let result = read_file_preview("/tmp/nonexistent_file_that_does_not_exist_12345.txt".to_string(), None);
        assert!(result.is_err(), "should return Err for nonexistent file");
    }

    // --- 1-shot / OneShotConfig / MergeStrategy tests ---

    #[test]
    fn merge_strategy_deserializes_from_string() {
        use oneshot::MergeStrategy;

        let merge: MergeStrategy =
            serde_json::from_str(r#""merge_to_main""#).expect("should deserialize merge_to_main");
        assert_eq!(merge, MergeStrategy::MergeToMain);

        let branch: MergeStrategy =
            serde_json::from_str(r#""branch""#).expect("should deserialize branch");
        assert_eq!(branch, MergeStrategy::Branch);
    }

    #[test]
    fn merge_strategy_round_trips() {
        use oneshot::MergeStrategy;

        for strategy in [MergeStrategy::MergeToMain, MergeStrategy::Branch] {
            let json = serde_json::to_string(&strategy).expect("serialization should succeed");
            let deserialized: MergeStrategy =
                serde_json::from_str(&json).expect("deserialization should succeed");
            assert_eq!(strategy, deserialized);
        }
    }

    #[test]
    fn oneshot_config_can_be_constructed() {
        use oneshot::{MergeStrategy, OneShotConfig};

        let mut env = HashMap::new();
        env.insert("FOO".to_string(), "bar".to_string());

        let config = OneShotConfig {
            repo_id: "repo-123".to_string(),
            repo_path: PathBuf::from("/tmp/my-repo"),
            title: "Add login feature".to_string(),
            prompt: "Implement OAuth2 login flow".to_string(),
            model: "claude-sonnet-4-20250514".to_string(),
            merge_strategy: MergeStrategy::MergeToMain,
            env_vars: env,
        };

        assert_eq!(config.repo_id, "repo-123");
        assert_eq!(config.repo_path, PathBuf::from("/tmp/my-repo"));
        assert_eq!(config.title, "Add login feature");
        assert_eq!(config.prompt, "Implement OAuth2 login flow");
        assert_eq!(config.model, "claude-sonnet-4-20250514");
        assert_eq!(config.merge_strategy, MergeStrategy::MergeToMain);
        assert_eq!(config.env_vars.get("FOO").unwrap(), "bar");
    }

    #[test]
    fn tagged_session_event_serializes_oneshot_events() {
        // OneShotStarted
        let event = TaggedSessionEvent {
            repo_id: "repo-1".to_string(),
            event: SessionEvent::OneShotStarted {
                title: "Add feature X".to_string(),
                merge_strategy: "merge_to_main".to_string(),
            },
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["repo_id"], "repo-1");
        assert_eq!(json["event"]["kind"], "one_shot_started");
        assert_eq!(json["event"]["title"], "Add feature X");
        assert_eq!(json["event"]["merge_strategy"], "merge_to_main");

        // DesignPhaseStarted
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::DesignPhaseStarted,
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["repo_id"], "repo-2");
        assert_eq!(json["event"]["kind"], "design_phase_started");

        // DesignPhaseComplete
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::DesignPhaseComplete {
                plan_file: "/tmp/plan.md".to_string(),
            },
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["event"]["kind"], "design_phase_complete");
        assert_eq!(json["event"]["plan_file"], "/tmp/plan.md");

        // ImplementationPhaseStarted
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::ImplementationPhaseStarted,
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["event"]["kind"], "implementation_phase_started");

        // ImplementationPhaseComplete
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::ImplementationPhaseComplete,
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["event"]["kind"], "implementation_phase_complete");

        // GitFinalizeStarted
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::GitFinalizeStarted {
                strategy: "branch".to_string(),
            },
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["event"]["kind"], "git_finalize_started");
        assert_eq!(json["event"]["strategy"], "branch");

        // GitFinalizeComplete
        let event = TaggedSessionEvent {
            repo_id: "repo-2".to_string(),
            event: SessionEvent::GitFinalizeComplete,
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["event"]["kind"], "git_finalize_complete");

        // OneShotComplete
        let event = TaggedSessionEvent {
            repo_id: "repo-3".to_string(),
            event: SessionEvent::OneShotComplete,
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["repo_id"], "repo-3");
        assert_eq!(json["event"]["kind"], "one_shot_complete");

        // OneShotFailed
        let event = TaggedSessionEvent {
            repo_id: "repo-4".to_string(),
            event: SessionEvent::OneShotFailed {
                reason: "design phase timed out".to_string(),
            },
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["repo_id"], "repo-4");
        assert_eq!(json["event"]["kind"], "one_shot_failed");
        assert_eq!(json["event"]["reason"], "design phase timed out");
    }
}
