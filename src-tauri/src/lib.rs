pub mod output;
pub mod runtime;
pub mod session;
pub mod trace;

use std::path::{Path, PathBuf};

use runtime::{MockRuntime, WslRuntime};
use session::{SessionConfig, SessionRunner};
use tauri::Emitter;
use trace::TraceCollector;

#[tauri::command]
async fn run_mock_session(app: tauri::AppHandle) -> Result<trace::SessionTrace, String> {
    let runtime = MockRuntime::completing_after(3);

    let config = SessionConfig {
        repo_path: PathBuf::from("/mock/project"),
        prompt: "Mock prompt: implement tasks and signal completion.".to_string(),
        max_iterations: 10,
        completion_signal: "<promise>COMPLETE</promise>".to_string(),
        model: None,
        extra_args: vec![],
        inter_iteration_delay_ms: 100,
    };

    let collector = TraceCollector::new("./traces");

    let app_handle = app.clone();
    let runner = SessionRunner::new(config, collector).on_event(Box::new(move |event| {
        let _ = app_handle.emit("session-event", event.clone());
    }));

    runner.run(&runtime).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn run_session(
    app: tauri::AppHandle,
    repo_path: String,
    prompt_file: String,
) -> Result<trace::SessionTrace, String> {
    let repo = PathBuf::from(&repo_path);

    // Resolve prompt file: if relative, join with repo_path
    let prompt_path = {
        let p = Path::new(&prompt_file);
        if p.is_relative() {
            repo.join(p)
        } else {
            p.to_path_buf()
        }
    };

    let prompt = tokio::fs::read_to_string(&prompt_path)
        .await
        .map_err(|e| format!("Failed to read prompt file {}: {e}", prompt_path.display()))?;

    let runtime = WslRuntime::new();

    let config = SessionConfig {
        repo_path: repo,
        prompt,
        max_iterations: 40,
        completion_signal: "ALL TODO ITEMS COMPLETE".to_string(),
        model: Some("opus".to_string()),
        extra_args: vec!["--dangerously-skip-permissions".to_string()],
        inter_iteration_delay_ms: 1000,
    };

    let collector = TraceCollector::new("./traces");

    let app_handle = app.clone();
    let runner = SessionRunner::new(config, collector).on_event(Box::new(move |event| {
        let _ = app_handle.emit("session-event", event.clone());
    }));

    runner.run(&runtime).await.map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_mock_session, run_session])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
