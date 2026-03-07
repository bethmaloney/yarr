pub mod output;
pub mod prompt;
pub mod runtime;
pub mod session;
pub mod trace;

use std::path::{Path, PathBuf};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;

use runtime::{LocalRuntime, MockRuntime};
use session::{SessionConfig, SessionEvent, SessionRunner};
use tauri::{Emitter, Manager};
use trace::TraceCollector;

/// Wraps a `SessionEvent` with a `repo_id` so the frontend can demux events
/// from concurrent sessions running against different repositories.
#[derive(serde::Serialize, Clone)]
pub(crate) struct TaggedSessionEvent {
    repo_id: String,
    event: SessionEvent,
}

/// Shared state for the active session's cancellation token
struct ActiveSession {
    cancel_token: Mutex<Option<CancellationToken>>,
}

#[tauri::command]
async fn run_mock_session(app: tauri::AppHandle, repo_id: String) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    {
        let active = app.state::<ActiveSession>();
        *active.cancel_token.lock().await = Some(cancel_token.clone());
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
    };

    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let collector = TraceCollector::new(base_dir, &repo_id);

    let app_handle = app.clone();
    let repo_id_clone = repo_id.clone();
    let runner = SessionRunner::new(config, collector, cancel_token).on_event(Box::new(move |event| {
        let _ = app_handle.emit("session-event", TaggedSessionEvent {
            repo_id: repo_id_clone.clone(),
            event: event.clone(),
        });
    }));

    let result = runner.run(&runtime).await.map_err(|e| e.to_string());
    *app.state::<ActiveSession>().cancel_token.lock().await = None;
    result
}

#[tauri::command]
async fn run_session(
    app: tauri::AppHandle,
    repo_id: String,
    repo_path: String,
    plan_file: String,
    model: String,
    max_iterations: u32,
    completion_signal: String,
) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    {
        let active = app.state::<ActiveSession>();
        *active.cancel_token.lock().await = Some(cancel_token.clone());
    }

    let repo = PathBuf::from(&repo_path);

    // Resolve plan file to absolute path for the @file reference
    let plan_path = {
        let p = Path::new(&plan_file);
        if p.is_relative() {
            repo.join(p)
        } else {
            p.to_path_buf()
        }
    };

    // Verify plan file exists before building prompt
    if !plan_path.exists() {
        *app.state::<ActiveSession>().cancel_token.lock().await = None;
        return Err(format!("Plan file not found: {}", plan_path.display()));
    }

    let prompt = prompt::build_prompt(&plan_path.to_string_lossy());

    let runtime = LocalRuntime::new();

    let config = SessionConfig {
        repo_path: repo,
        prompt,
        max_iterations,
        completion_signal,
        model: Some(model),
        extra_args: vec!["--dangerously-skip-permissions".to_string()],
        plan_file: Some(plan_file),
        inter_iteration_delay_ms: 1000,
    };

    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let collector = TraceCollector::new(base_dir, &repo_id);

    let app_handle = app.clone();
    let repo_id_clone = repo_id.clone();
    let runner = SessionRunner::new(config, collector, cancel_token).on_event(Box::new(move |event| {
        let _ = app_handle.emit("session-event", TaggedSessionEvent {
            repo_id: repo_id_clone.clone(),
            event: event.clone(),
        });
    }));

    let result = runner.run(&runtime).await.map_err(|e| e.to_string());
    *app.state::<ActiveSession>().cancel_token.lock().await = None;
    result
}

#[tauri::command]
async fn stop_session(app: tauri::AppHandle) -> Result<(), String> {
    let active = app.state::<ActiveSession>();
    let token = active.cancel_token.lock().await;
    if let Some(ref t) = *token {
        t.cancel();
        Ok(())
    } else {
        Err("No active session to stop".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(ActiveSession {
            cancel_token: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![run_mock_session, run_session, stop_session])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
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
}
