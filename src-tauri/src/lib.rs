pub mod output;
pub mod runtime;
pub mod session;
pub mod trace;

use std::path::PathBuf;

use runtime::MockRuntime;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![run_mock_session])
        .run(tauri::generate_context!())
        .expect("error running tauri application");
}
