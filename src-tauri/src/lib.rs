pub mod git_merge;
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
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use oneshot::OneShotRunner;
use runtime::{default_runtime, ssh_command, ssh_command_raw, ssh_shell_escape, RuntimeProvider, SshEnvCache, SshRuntime};
use session::{SessionConfig, SessionEvent, SessionRunner};
use ssh_orchestrator::SshSessionOrchestrator;
use tauri::{Emitter, Manager, RunEvent, WebviewWindow};
use trace::TraceCollector;

/// Wraps a `SessionEvent` with a `repo_id` so the frontend can demux events
/// from concurrent sessions running against different repositories.
#[derive(serde::Serialize, Clone)]
pub(crate) struct TaggedSessionEvent {
    repo_id: String,
    event: SessionEvent,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoGitStatus {
    branch_name: String,
    dirty_count: u32,
    ahead: Option<u32>,
    behind: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SshTestStep {
    step: String,
    status: String,
    error: Option<String>,
}

/// Shared state tracking cancellation tokens for all active sessions, keyed by repo_id
struct SessionHandle {
    cancel_token: CancellationToken,
    session_id: String,
    join_handle: JoinHandle<()>,
}

struct ActiveSessions {
    tokens: Mutex<HashMap<String, SessionHandle>>,
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
async fn run_session(
    app: tauri::AppHandle,
    repo_id: String,
    repo: RepoType,
    plan_file: String,
    model: String,
    effort_level: Option<String>,
    max_iterations: u32,
    completion_signal: String,
    env_vars: Option<HashMap<String, String>>,
    checks: Option<Vec<session::Check>>,
    git_sync: Option<session::GitSyncConfig>,
    create_branch: bool,
    implementation_prompt_file: Option<String>,
) -> Result<SessionResult, String> {
    tracing::info!(repo_id = %repo_id, model = %model, effort_level = ?effort_level, repo_type = ?repo, "run_session called");
    let cancel_token = CancellationToken::new();
    let session_id = Uuid::new_v4().to_string();
    {
        let active = app.state::<ActiveSessions>();
        let mut sessions = active.tokens.lock().await;
        if sessions.contains_key(&repo_id) {
            return Err("Session already running for this repo".to_string());
        }
        // Insert placeholder to hold the slot — prevents a second call from passing the reject guard
        tracing::info!(repo_id = %repo_id, session_id = %session_id, "inserting session into ActiveSessions (placeholder)");
        sessions.insert(repo_id.clone(), SessionHandle {
            cancel_token: cancel_token.clone(),
            session_id: session_id.clone(),
            join_handle: tokio::spawn(async {}),
        });
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);
            let runtime = default_runtime();

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = runtime.resolve_env().await;
            if let Some(warning) = runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

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

            if create_branch {
                let branch_name = generate_branch_name(&plan_file);
                let timeout = std::time::Duration::from_secs(30);
                let output = runtime
                    .run_command(
                        &format!("git checkout -b {branch_name}"),
                        &repo_path_buf,
                        timeout,
                    )
                    .await;

                match output {
                    Ok(o) if o.exit_code != 0 => {
                        app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        return Err(format!(
                            "Failed to create branch '{}': {}",
                            branch_name, o.stderr
                        ));
                    }
                    Err(e) => {
                        app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        return Err(format!(
                            "Failed to create branch '{}': {}",
                            branch_name, e
                        ));
                    }
                    Ok(_) => {} // success, continue
                }
            }

            let custom_prompt_content = if let Some(ref prompt_file) = implementation_prompt_file {
                let prompt_path = if Path::new(prompt_file).is_relative() {
                    repo_path_buf.join(prompt_file)
                } else {
                    PathBuf::from(prompt_file)
                };
                match tokio::fs::read_to_string(&prompt_path).await {
                    Ok(content) => {
                        tracing::info!(prompt_file = %prompt_path.display(), content_len = content.len(), "loaded custom implementation prompt");
                        Some(content)
                    }
                    Err(e) => {
                        app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        return Err(format!("Failed to read custom prompt file '{}': {}", prompt_path.display(), e));
                    }
                }
            } else {
                None
            };
            let prompt = prompt::build_prompt(&plan_path.to_string_lossy(), custom_prompt_content.as_deref());

            let plan_file_for_spawn = plan_file.clone();
            let config = SessionConfig {
                repo_path: repo_path_buf,
                working_dir: None,
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                effort_level,
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync,
                iteration_offset: 0,
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
            let session_complete_emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let session_complete_flag = session_complete_emitted.clone();
            let app_handle = app.clone();
            let repo_id_clone = repo_id.clone();
            let runner = SessionRunner::new(config, collector, cancel_token.clone())
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    if matches!(event, SessionEvent::SessionComplete { .. }) {
                        session_complete_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: repo_id_clone.clone(),
                        event: event.clone(),
                    }) {
                        tracing::warn!(error = %e, "failed to emit session-event");
                    }
                }))
                .with_session_id(session_id.clone());

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let repo_id_bg = repo_id.clone();
            let session_complete_emitted_bg = session_complete_emitted.clone();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let repo_id = repo_id_bg.clone();
                    move |_| {
                        let app = app.clone();
                        let repo_id = repo_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %repo_id, reason = "session ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        });
                    }
                });

                let runtime = default_runtime();
                if let Err(e) = runner.run(runtime.as_ref()).await {
                    tracing::error!(repo_id = %repo_id_bg, error = %e, "session runner failed");
                    if !session_complete_emitted_bg.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Err(emit_err) = app_bg.emit("session-event", TaggedSessionEvent {
                            repo_id: repo_id_bg.clone(),
                            event: SessionEvent::SessionComplete {
                                outcome: trace::SessionOutcome::Failed,
                                plan_file: Some(plan_file_for_spawn),
                            },
                        }) {
                            tracing::warn!(error = %emit_err, "failed to emit session-event");
                        }
                    }
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&repo_id) {
                    handle.join_handle = join_handle;
                }
            }

            tracing::info!(repo_id = %repo_id, session_id = %session_id, "run_session spawned successfully (local)");
            Ok(SessionResult { session_id })
        }
        RepoType::Ssh { ssh_host, remote_path } => {
            let ssh_runtime = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = ssh_runtime.resolve_env().await;
            if let Some(warning) = ssh_runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

            let plan_path = {
                let p = std::path::Path::new(&plan_file);
                if p.is_relative() {
                    PathBuf::from(remote_path).join(p)
                } else {
                    p.to_path_buf()
                }
            };

            // We can't verify the plan file exists on remote, skip the check
            let custom_prompt_content = if let Some(ref prompt_file) = implementation_prompt_file {
                let timeout = std::time::Duration::from_secs(30);
                let remote_prompt_path = if Path::new(prompt_file).is_relative() {
                    PathBuf::from(remote_path).join(prompt_file)
                } else {
                    PathBuf::from(prompt_file)
                };
                match ssh_runtime.run_command(&format!("cat {}", ssh_shell_escape(&remote_prompt_path.to_string_lossy())), &PathBuf::from(remote_path), timeout).await {
                    Ok(output) if output.exit_code == 0 => {
                        tracing::info!(prompt_file = %remote_prompt_path.display(), content_len = output.stdout.len(), "loaded custom implementation prompt");
                        Some(output.stdout)
                    }
                    Ok(output) => {
                        app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        return Err(format!("Failed to read custom prompt file '{}': {}", prompt_file, output.stderr));
                    }
                    Err(e) => {
                        app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        return Err(format!("Failed to read custom prompt file '{}': {}", prompt_file, e));
                    }
                }
            } else {
                None
            };
            let prompt = prompt::build_prompt(&plan_path.to_string_lossy(), custom_prompt_content.as_deref());

            let plan_file_for_spawn = plan_file.clone();
            let config = SessionConfig {
                repo_path: PathBuf::from(remote_path),
                working_dir: None,
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                effort_level,
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync,
                iteration_offset: 0,
            };

            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                    return Err(e.to_string());
                }
            };
            let collector = TraceCollector::new(base_dir, &repo_id);

            let orchestrator = SshSessionOrchestrator::new(
                ssh_runtime,
                config,
                collector,
                cancel_token.clone(),
            )
            .with_trace_session_id(session_id.clone());

            // Store reconnect handle
            let reconnect_notify = orchestrator.reconnect_notify();
            {
                let ssh_sessions = app.state::<ActiveSshSessions>();
                ssh_sessions.sessions.lock().unwrap().insert(repo_id.clone(), reconnect_notify);
                tracing::debug!(repo_id = %repo_id, "registered SSH session in ActiveSshSessions");
            }

            let session_complete_emitted = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let session_complete_flag = session_complete_emitted.clone();
            let app_handle = app.clone();
            let repo_id_clone = repo_id.clone();
            let orchestrator = orchestrator.on_event(Box::new(move |event| {
                if matches!(event, SessionEvent::SessionComplete { .. }) {
                    session_complete_flag.store(true, std::sync::atomic::Ordering::SeqCst);
                }
                if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                    repo_id: repo_id_clone.clone(),
                    event: event.clone(),
                }) {
                    tracing::warn!(error = %e, "failed to emit session-event");
                }
            }));

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let repo_id_bg = repo_id.clone();
            let session_complete_emitted_bg = session_complete_emitted.clone();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let repo_id = repo_id_bg.clone();
                    move |_| {
                        // Clean up ActiveSshSessions (std::sync::Mutex — synchronous)
                        {
                            let ssh_sessions = app.state::<ActiveSshSessions>();
                            ssh_sessions.sessions.lock().unwrap().remove(&repo_id);
                            tracing::debug!(repo_id = %repo_id, "unregistered SSH session from ActiveSshSessions");
                        }
                        // Clean up ActiveSessions (tokio::sync::Mutex — must spawn)
                        let app = app.clone();
                        let repo_id = repo_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %repo_id, reason = "ssh session ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
                        });
                    }
                });

                if let Err(e) = orchestrator.run().await {
                    tracing::error!(repo_id = %repo_id_bg, error = %e, "ssh session orchestrator failed");
                    if !session_complete_emitted_bg.load(std::sync::atomic::Ordering::SeqCst) {
                        if let Err(emit_err) = app_bg.emit("session-event", TaggedSessionEvent {
                            repo_id: repo_id_bg.clone(),
                            event: SessionEvent::SessionComplete {
                                outcome: trace::SessionOutcome::Failed,
                                plan_file: Some(plan_file_for_spawn),
                            },
                        }) {
                            tracing::warn!(error = %emit_err, "failed to emit session-event");
                        }
                    }
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&repo_id) {
                    handle.join_handle = join_handle;
                }
            }

            tracing::info!(repo_id = %repo_id, session_id = %session_id, "run_session spawned successfully (ssh)");
            Ok(SessionResult { session_id })
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct SessionResult {
    pub session_id: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct OneShotResult {
    pub oneshot_id: String,
    pub session_id: String,
}

#[tauri::command]
async fn run_oneshot(
    app: tauri::AppHandle,
    repo_id: String,
    repo: RepoType,
    title: String,
    prompt: String,
    model: String,
    effort_level: Option<String>,
    design_effort_level: Option<String>,
    merge_strategy: oneshot::MergeStrategy,
    env_vars: Option<HashMap<String, String>>,
    max_iterations: u32,
    completion_signal: String,
    checks: Option<Vec<session::Check>>,
    git_sync: Option<session::GitSyncConfig>,
    plans_dir: Option<String>,
    move_plans_to_completed: Option<bool>,
    design_prompt_file: Option<String>,
    implementation_prompt_file: Option<String>,
) -> Result<OneShotResult, String> {
    let oneshot_id = oneshot::generate_oneshot_id();
    let cancel_token = CancellationToken::new();
    let session_id = Uuid::new_v4().to_string();
    let session_id_for_result = session_id.clone();
    tracing::info!(oneshot_id = %oneshot_id, repo_id = %repo_id, effort_level = ?effort_level, design_effort_level = ?design_effort_level, repo_type = ?repo, "run_oneshot called");
    {
        let active = app.state::<ActiveSessions>();
        tracing::info!(oneshot_id = %oneshot_id, repo_id = %repo_id, session_id = %session_id, "inserting oneshot into ActiveSessions (placeholder)");
        let mut sessions = active.tokens.lock().await;
        sessions.insert(oneshot_id.clone(), SessionHandle { cancel_token: cancel_token.clone(), session_id: session_id.clone(), join_handle: tokio::spawn(async {}) });
        if let Some(existing_handle) = sessions.get(&repo_id) {
            tracing::info!(
                oneshot_id = %oneshot_id,
                repo_id = %repo_id,
                existing_session_id = %existing_handle.session_id,
                "launching oneshot while ralph loop is active for repo"
            );
        }
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);

            // Pre-warm env cache and emit warning if snapshot failed
            let runtime = default_runtime();
            let _ = runtime.resolve_env().await;
            if let Some(warning) = runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: repo_path_buf,
                title,
                prompt,
                model,
                effort_level: effort_level.unwrap_or_else(|| "medium".to_string()),
                design_effort_level: design_effort_level.unwrap_or_else(|| "high".to_string()),
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
                max_iterations,
                completion_signal,
                checks: checks.unwrap_or_default(),
                git_sync,
                plans_dir: plans_dir.unwrap_or_else(|| "docs/plans/".to_string()),
                move_plans_to_completed: move_plans_to_completed.unwrap_or(true),
                ssh_host: None,
                design_prompt_file: design_prompt_file.clone(),
                implementation_prompt_file: implementation_prompt_file.clone(),
            };

            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    tracing::error!(oneshot_id = %oneshot_id, error = %e, "failed to resolve app data dir");
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                    return Err(e.to_string());
                }
            };
            let collector = TraceCollector::new(base_dir, &oneshot_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let oneshot_id_clone = oneshot_id.clone();
            let runner = OneShotRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: oneshot_id_clone.clone(),
                        event: event.clone(),
                    }) {
                        tracing::warn!(error = %e, "failed to emit session-event");
                    }
                }))
                .with_session_id(session_id);

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let oneshot_id_bg = oneshot_id.clone();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let oneshot_id = oneshot_id_bg.clone();
                    move |_| {
                        let app = app.clone();
                        let oneshot_id = oneshot_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %oneshot_id, reason = "oneshot ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                        });
                    }
                });

                let runtime = default_runtime();
                if let Err(e) = runner.run(runtime.as_ref()).await {
                    tracing::error!(oneshot_id = %oneshot_id_bg, error = %e, "oneshot runner failed");
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&oneshot_id) {
                    handle.join_handle = join_handle;
                }
            }

            Ok(OneShotResult { oneshot_id, session_id: session_id_for_result })
        }
        RepoType::Ssh { ssh_host, remote_path } => {
            let ssh_runtime = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = ssh_runtime.resolve_env().await;
            if let Some(warning) = ssh_runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: PathBuf::from(remote_path),
                title,
                prompt,
                model,
                effort_level: effort_level.unwrap_or_default(),
                design_effort_level: design_effort_level.unwrap_or_default(),
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
                max_iterations,
                completion_signal,
                checks: checks.unwrap_or_default(),
                git_sync,
                plans_dir: plans_dir.unwrap_or_else(|| "docs/plans/".to_string()),
                move_plans_to_completed: move_plans_to_completed.unwrap_or(true),
                ssh_host: Some(ssh_host.clone()),
                design_prompt_file,
                implementation_prompt_file,
            };

            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    tracing::error!(oneshot_id = %oneshot_id, error = %e, "failed to resolve app data dir");
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                    return Err(e.to_string());
                }
            };
            let collector = TraceCollector::new(base_dir, &oneshot_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let oneshot_id_clone = oneshot_id.clone();

            // Create a separate SshRuntime for the runner (SshRuntime is not Clone)
            let ssh_runtime_for_runner = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());
            let runner = OneShotRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: oneshot_id_clone.clone(),
                        event: event.clone(),
                    }) {
                        tracing::warn!(error = %e, "failed to emit session-event");
                    }
                }))
                .with_session_id(session_id)
                .with_ssh_runtime(ssh_runtime_for_runner);

            // Store reconnect notify in ActiveSshSessions — use the runner's shared notify
            // so reconnect_session signals propagate to the SshSessionOrchestrator per phase
            let reconnect_notify = runner.reconnect_notify();
            {
                let ssh_sessions = app.state::<ActiveSshSessions>();
                ssh_sessions.sessions.lock().unwrap().insert(oneshot_id.clone(), reconnect_notify);
                tracing::debug!(oneshot_id = %oneshot_id, "registered SSH oneshot in ActiveSshSessions");
            }

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let oneshot_id_bg = oneshot_id.clone();
            let ssh_host_bg = ssh_host.clone();
            let remote_path_bg = remote_path.clone();
            let env_cache = app.state::<SshEnvCache>().cache_ref();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let oneshot_id = oneshot_id_bg.clone();
                    move |_| {
                        // Clean up ActiveSshSessions (std::sync::Mutex — synchronous)
                        {
                            let ssh_sessions = app.state::<ActiveSshSessions>();
                            ssh_sessions.sessions.lock().unwrap().remove(&oneshot_id);
                            tracing::debug!(repo_id = %oneshot_id, "unregistered SSH oneshot from ActiveSshSessions");
                        }
                        // Clean up ActiveSessions (tokio::sync::Mutex — must spawn)
                        let app = app.clone();
                        let oneshot_id = oneshot_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %oneshot_id, reason = "ssh oneshot ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                        });
                    }
                });

                let ssh_runtime = SshRuntime::new(&ssh_host_bg, &remote_path_bg, env_cache);
                if let Err(e) = runner.run(&ssh_runtime).await {
                    tracing::error!(oneshot_id = %oneshot_id_bg, error = %e, "ssh oneshot runner failed");
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&oneshot_id) {
                    handle.join_handle = join_handle;
                }
            }

            Ok(OneShotResult { oneshot_id, session_id: session_id_for_result })
        }
    }
}

#[tauri::command]
async fn resume_oneshot(
    app: tauri::AppHandle,
    oneshot_id: String,
    repo_id: String,
    repo: RepoType,
    title: String,
    prompt: String,
    model: String,
    effort_level: Option<String>,
    design_effort_level: Option<String>,
    merge_strategy: oneshot::MergeStrategy,
    env_vars: Option<HashMap<String, String>>,
    max_iterations: u32,
    completion_signal: String,
    checks: Option<Vec<session::Check>>,
    git_sync: Option<session::GitSyncConfig>,
    plans_dir: Option<String>,
    move_plans_to_completed: Option<bool>,
    worktree_path: String,
    branch: String,
    old_session_id: String,
    design_prompt_file: Option<String>,
    implementation_prompt_file: Option<String>,
) -> Result<OneShotResult, String> {
    let session_id = Uuid::new_v4().to_string();
    let session_id_for_result = session_id.clone();
    let cancel_token = CancellationToken::new();
    tracing::info!(oneshot_id = %oneshot_id, repo_id = %repo_id, repo_type = ?repo, effort_level = ?effort_level, design_effort_level = ?design_effort_level, "resume_oneshot called");
    {
        let active = app.state::<ActiveSessions>();
        tracing::info!(oneshot_id = %oneshot_id, repo_id = %repo_id, session_id = %session_id, "inserting resume oneshot into ActiveSessions (placeholder)");
        active.tokens.lock().await.insert(oneshot_id.clone(), SessionHandle { cancel_token: cancel_token.clone(), session_id: session_id.clone(), join_handle: tokio::spawn(async {}) });
    }

    match &repo {
        RepoType::Local { path } => {
            // Validate worktree_path to prevent shell injection
            if worktree_path.contains(';') || worktree_path.contains('$') || worktree_path.contains('`')
                || worktree_path.contains('|') || worktree_path.contains('&') || worktree_path.contains('\n')
                || worktree_path.contains('\'') || worktree_path.contains('"') || worktree_path.contains('\\')
                || worktree_path.contains('(') || worktree_path.contains(')') {
                tracing::warn!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "resume_oneshot: invalid worktree path");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Invalid worktree path".to_string());
            }

            if branch.contains(';') || branch.contains('$') || branch.contains('`')
                || branch.contains('|') || branch.contains('&') || branch.contains('\n')
                || branch.contains('\'') || branch.contains('"') || branch.contains('\\')
                || branch.contains(' ') || branch.contains('(') || branch.contains(')') {
                tracing::warn!(oneshot_id = %oneshot_id, branch = %branch, "resume_oneshot: invalid branch name");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Invalid branch name".to_string());
            }

            let repo_path_buf = PathBuf::from(path);

            // Pre-warm env cache and emit warning if snapshot failed
            let runtime = default_runtime();
            let _ = runtime.resolve_env().await;
            if let Some(warning) = runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

            // Load events from previous session
            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                    return Err(e.to_string());
                }
            };
            let events = match TraceCollector::read_events(&base_dir, &oneshot_id, &old_session_id) {
                Ok(events) => {
                    tracing::info!(oneshot_id = %oneshot_id, event_count = events.len(), "loaded events from previous session");
                    events
                }
                Err(e) => {
                    tracing::warn!("Failed to read events for resume (oneshot_id={}, session_id={}): {}. Will re-run all phases.", oneshot_id, old_session_id, e);
                    Vec::new()
                }
            };

            // Detect which phases to skip
            let resume_state = oneshot::detect_resume_phase(
                &events,
                PathBuf::from(&worktree_path),
                branch.clone(),
            );
            tracing::info!(
                oneshot_id = %oneshot_id,
                skip_design = resume_state.skip_design,
                skip_implementation = resume_state.skip_implementation,
                plan_file = ?resume_state.plan_file,
                "detected resume phase"
            );

            // Verify worktree still exists on disk
            tracing::info!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "verifying worktree exists");
            let wt_check = runtime
                .run_command(
                    &format!("test -d {}", worktree_path),
                    &repo_path_buf,
                    std::time::Duration::from_secs(10),
                )
                .await
                .map_err(|e| e.to_string())?;
            if wt_check.exit_code != 0 {
                tracing::error!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "worktree no longer exists on disk");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Worktree no longer exists on disk".to_string());
            }

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: repo_path_buf,
                title,
                prompt,
                model,
                effort_level: effort_level.unwrap_or_else(|| "medium".to_string()),
                design_effort_level: design_effort_level.unwrap_or_else(|| "high".to_string()),
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
                max_iterations,
                completion_signal,
                checks: checks.unwrap_or_default(),
                git_sync,
                plans_dir: plans_dir.unwrap_or_else(|| "docs/plans/".to_string()),
                move_plans_to_completed: move_plans_to_completed.unwrap_or(true),
                ssh_host: None,
                design_prompt_file: design_prompt_file.clone(),
                implementation_prompt_file: implementation_prompt_file.clone(),
            };

            let collector = TraceCollector::new(base_dir, &oneshot_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let oneshot_id_clone = oneshot_id.clone();
            let runner = OneShotRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: oneshot_id_clone.clone(),
                        event: event.clone(),
                    }) {
                        tracing::warn!(error = %e, "failed to emit session-event");
                    }
                }))
                .with_resume_state(resume_state)
                .with_session_id(session_id);

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let oneshot_id_bg = oneshot_id.clone();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let oneshot_id = oneshot_id_bg.clone();
                    move |_| {
                        let app = app.clone();
                        let oneshot_id = oneshot_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %oneshot_id, reason = "resume oneshot ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                        });
                    }
                });

                let runtime = default_runtime();
                if let Err(e) = runner.run(runtime.as_ref()).await {
                    tracing::error!(oneshot_id = %oneshot_id_bg, error = %e, "resume oneshot runner failed");
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&oneshot_id) {
                    handle.join_handle = join_handle;
                }
            }

            Ok(OneShotResult { oneshot_id, session_id: session_id_for_result })
        }
        RepoType::Ssh { ssh_host, remote_path } => {
            // Validate worktree_path to prevent shell injection
            if worktree_path.contains(';') || worktree_path.contains('$') || worktree_path.contains('`')
                || worktree_path.contains('|') || worktree_path.contains('&') || worktree_path.contains('\n')
                || worktree_path.contains('\'') || worktree_path.contains('"') || worktree_path.contains('\\')
                || worktree_path.contains('(') || worktree_path.contains(')') {
                tracing::warn!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "resume_oneshot: invalid worktree path");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Invalid worktree path".to_string());
            }

            if branch.contains(';') || branch.contains('$') || branch.contains('`')
                || branch.contains('|') || branch.contains('&') || branch.contains('\n')
                || branch.contains('\'') || branch.contains('"') || branch.contains('\\')
                || branch.contains(' ') || branch.contains('(') || branch.contains(')') {
                tracing::warn!(oneshot_id = %oneshot_id, branch = %branch, "resume_oneshot: invalid branch name");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Invalid branch name".to_string());
            }

            let ssh_runtime = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = ssh_runtime.resolve_env().await;
            if let Some(warning) = ssh_runtime.env_warning() {
                if let Err(e) = app.emit("env-warning", &warning) {
                    tracing::warn!(error = %e, "failed to emit env-warning");
                }
            }

            // Load events from previous session
            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
                    app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                    return Err(e.to_string());
                }
            };
            let events = match TraceCollector::read_events(&base_dir, &oneshot_id, &old_session_id) {
                Ok(events) => {
                    tracing::info!(oneshot_id = %oneshot_id, event_count = events.len(), "loaded events from previous session");
                    events
                }
                Err(e) => {
                    tracing::warn!("Failed to read events for resume (oneshot_id={}, session_id={}): {}. Will re-run all phases.", oneshot_id, old_session_id, e);
                    Vec::new()
                }
            };

            // Detect which phases to skip
            let resume_state = oneshot::detect_resume_phase(
                &events,
                PathBuf::from(&worktree_path),
                branch.clone(),
            );
            tracing::info!(
                oneshot_id = %oneshot_id,
                skip_design = resume_state.skip_design,
                skip_implementation = resume_state.skip_implementation,
                plan_file = ?resume_state.plan_file,
                "detected resume phase (ssh)"
            );

            // Verify worktree still exists on remote
            tracing::info!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "verifying worktree exists on remote");
            let repo_path_buf = PathBuf::from(remote_path);
            let wt_check = ssh_runtime
                .run_command(
                    &format!("test -d {}", worktree_path),
                    &repo_path_buf,
                    std::time::Duration::from_secs(10),
                )
                .await
                .map_err(|e| e.to_string())?;
            if wt_check.exit_code != 0 {
                tracing::error!(oneshot_id = %oneshot_id, worktree_path = %worktree_path, "worktree no longer exists on remote");
                app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                return Err("Worktree no longer exists on remote".to_string());
            }

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: repo_path_buf,
                title,
                prompt,
                model,
                effort_level: effort_level.unwrap_or_default(),
                design_effort_level: design_effort_level.unwrap_or_default(),
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
                max_iterations,
                completion_signal,
                checks: checks.unwrap_or_default(),
                git_sync,
                plans_dir: plans_dir.unwrap_or_else(|| "docs/plans/".to_string()),
                move_plans_to_completed: move_plans_to_completed.unwrap_or(true),
                ssh_host: Some(ssh_host.clone()),
                design_prompt_file,
                implementation_prompt_file,
            };

            let collector = TraceCollector::new(base_dir, &oneshot_id);

            let abort_registry = app.state::<GlobalAbortRegistry>().inner.clone();
            let app_handle = app.clone();
            let oneshot_id_clone = oneshot_id.clone();

            // Create a separate SshRuntime for the runner (SshRuntime is not Clone)
            let ssh_runtime_for_runner = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());
            let runner = OneShotRunner::new(config, collector, cancel_token)
                .abort_registry(abort_registry)
                .on_event(Box::new(move |event| {
                    if let Err(e) = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: oneshot_id_clone.clone(),
                        event: event.clone(),
                    }) {
                        tracing::warn!(error = %e, "failed to emit session-event");
                    }
                }))
                .with_resume_state(resume_state)
                .with_session_id(session_id)
                .with_ssh_runtime(ssh_runtime_for_runner);

            // Store reconnect notify in ActiveSshSessions — use the runner's shared notify
            let reconnect_notify = runner.reconnect_notify();
            {
                let ssh_sessions = app.state::<ActiveSshSessions>();
                ssh_sessions.sessions.lock().unwrap().insert(oneshot_id.clone(), reconnect_notify);
                tracing::debug!(oneshot_id = %oneshot_id, "registered SSH resume oneshot in ActiveSshSessions");
            }

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let oneshot_id_bg = oneshot_id.clone();
            let ssh_host_bg = ssh_host.clone();
            let remote_path_bg = remote_path.clone();
            let env_cache = app.state::<SshEnvCache>().cache_ref();
            let join_handle = tokio::spawn(async move {
                let _guard = scopeguard::guard((), {
                    let app = app_bg.clone();
                    let oneshot_id = oneshot_id_bg.clone();
                    move |_| {
                        // Clean up ActiveSshSessions (std::sync::Mutex — synchronous)
                        {
                            let ssh_sessions = app.state::<ActiveSshSessions>();
                            ssh_sessions.sessions.lock().unwrap().remove(&oneshot_id);
                            tracing::debug!(repo_id = %oneshot_id, "unregistered SSH resume oneshot from ActiveSshSessions");
                        }
                        // Clean up ActiveSessions (tokio::sync::Mutex — must spawn)
                        let app = app.clone();
                        let oneshot_id = oneshot_id.clone();
                        tokio::spawn(async move {
                            tracing::info!(repo_id = %oneshot_id, reason = "ssh resume oneshot ended", "removing session from ActiveSessions");
                            app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
                        });
                    }
                });

                let ssh_runtime = SshRuntime::new(&ssh_host_bg, &remote_path_bg, env_cache);
                if let Err(e) = runner.run(&ssh_runtime).await {
                    tracing::error!(oneshot_id = %oneshot_id_bg, error = %e, "ssh resume oneshot runner failed");
                }
            });

            // Update the placeholder with the real JoinHandle
            {
                let active = app.state::<ActiveSessions>();
                let mut sessions = active.tokens.lock().await;
                if let Some(handle) = sessions.get_mut(&oneshot_id) {
                    handle.join_handle = join_handle;
                }
            }

            Ok(OneShotResult { oneshot_id, session_id: session_id_for_result })
        }
    }
}

#[tauri::command]
fn list_traces(app: tauri::AppHandle, repo_id: Option<String>) -> Result<Vec<trace::SessionTrace>, String> {
    tracing::info!(repo_id = ?repo_id, "list_traces called");
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let traces = TraceCollector::list_traces(&base_dir, repo_id.as_deref()).map_err(|e| e.to_string())?;
    tracing::debug!(count = traces.len(), "list_traces succeeded");
    Ok(traces)
}

#[tauri::command]
fn list_latest_traces(app: tauri::AppHandle) -> Result<Vec<trace::SessionTrace>, String> {
    tracing::info!("list_latest_traces called");
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let traces = TraceCollector::list_latest_traces(&base_dir).map_err(|e| e.to_string())?;
    tracing::debug!(count = traces.len(), "list_latest_traces succeeded");
    Ok(traces)
}

#[tauri::command]
fn get_trace(app: tauri::AppHandle, repo_id: String, session_id: String) -> Result<trace::SessionTrace, String> {
    tracing::info!(repo_id = %repo_id, session_id = %session_id, "get_trace called");
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::read_trace(&base_dir, &repo_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_trace_events(app: tauri::AppHandle, repo_id: String, session_id: String) -> Result<Vec<session::SessionEvent>, String> {
    tracing::info!(repo_id = %repo_id, session_id = %session_id, "get_trace_events called");
    let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    TraceCollector::read_events(&base_dir, &repo_id, &session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_file_preview(path: String, max_lines: Option<u32>) -> Result<String, String> {
    tracing::debug!(path = %path, "read_file_preview called");
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let limit = max_lines.unwrap_or(5) as usize;
    let result: String = content.lines().take(limit).collect::<Vec<_>>().join("\n");
    Ok(result)
}

#[tauri::command]
async fn get_active_sessions(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    tracing::info!("get_active_sessions called");
    let active = app.state::<ActiveSessions>();
    let pairs: Vec<(String, String)> = active.tokens.lock().await
        .iter()
        .map(|(repo_id, handle)| (repo_id.clone(), handle.session_id.clone()))
        .collect();
    tracing::debug!(count = pairs.len(), "get_active_sessions succeeded");
    Ok(pairs)
}

#[tauri::command]
async fn stop_session(app: tauri::AppHandle, repo_id: String) -> Result<(), String> {
    tracing::info!(repo_id = %repo_id, "stop_session called");
    let active = app.state::<ActiveSessions>();
    let token = {
        let sessions = active.tokens.lock().await;
        sessions.get(&repo_id).map(|h| h.cancel_token.clone())
    };
    match token {
        Some(t) => {
            t.cancel();
            tracing::info!(repo_id = %repo_id, "stop_session: cancellation token triggered");
            Ok(())
        }
        None => {
            tracing::warn!(repo_id = %repo_id, "stop_session: no active session found");
            Err("No active session to stop".to_string())
        }
    }
}

fn connection_test_steps(ssh_host: &str, remote_path: &str) -> Vec<(String, tokio::process::Command)> {
    let trimmed_path = remote_path.trim();
    vec![
        ("SSH reachable".to_string(), ssh_command_raw(ssh_host, "echo OK")),
        ("tmux available".to_string(), ssh_command(ssh_host, "command -v tmux")),
        ("claude available".to_string(), ssh_command(ssh_host, "command -v claude")),
        ("Remote path exists".to_string(), ssh_command_raw(
            ssh_host,
            &format!("test -d {} && echo OK", ssh_shell_escape(trimmed_path))
        )),
    ]
}

async fn diagnose_path_failure(ssh_host: &str, remote_path: &str) -> String {
    let trimmed = remote_path.trim();
    let escaped = ssh_shell_escape(trimmed);
    let diag_cmd = format!(
        "if [ -e {0} ]; then if [ -d {0} ]; then if [ -r {0} ] && [ -x {0} ]; then echo ACCESSIBLE; else echo PERM_ISSUE; fi; else echo NOT_A_DIR; fi; else echo NOT_FOUND; fi",
        escaped
    );
    let output = ssh_command_raw(ssh_host, &diag_cmd).output().await;
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
            match stdout.as_str() {
                "NOT_FOUND" => format!("Directory does not exist: {trimmed}"),
                "NOT_A_DIR" => format!("Path exists but is not a directory: {trimmed}"),
                "PERM_ISSUE" => format!("Directory exists but is not accessible (check permissions): {trimmed}"),
                "ACCESSIBLE" => format!("Path check failed for: {trimmed}"),
                _ => format!("Path check failed for: {trimmed}"),
            }
        }
        Err(_) => format!("Path check failed for: {trimmed}"),
    }
}

#[tauri::command]
async fn test_ssh_connection_steps(app: tauri::AppHandle, ssh_host: String, remote_path: String) -> Result<(), String> {
    tracing::info!(ssh_host = %ssh_host, "test_ssh_connection_steps called");
    let remote_path = remote_path.trim().to_string();
    let steps = connection_test_steps(&ssh_host, &remote_path);
    for (step_name, mut cmd) in steps {
        let output = cmd.output().await.map_err(|e| e.to_string())?;
        if output.status.success() {
            if let Err(e) = app.emit("ssh-test-step", SshTestStep {
                step: step_name,
                status: "pass".to_string(),
                error: None,
            }) {
                tracing::warn!(error = %e, "failed to emit ssh-test-step");
            }
        } else {
            let error_msg = if step_name == "Remote path exists" {
                diagnose_path_failure(&ssh_host, &remote_path).await
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if stderr.is_empty() { "Check failed".to_string() } else { stderr }
            };
            if let Err(e) = app.emit("ssh-test-step", SshTestStep {
                step: step_name,
                status: "fail".to_string(),
                error: Some(error_msg),
            }) {
                tracing::warn!(error = %e, "failed to emit ssh-test-step");
            }
            if let Err(e) = app.emit("ssh-test-complete", ()) {
                tracing::warn!(error = %e, "failed to emit ssh-test-complete");
            }
            return Ok(());
        }
    }
    if let Err(e) = app.emit("ssh-test-complete", ()) {
        tracing::warn!(error = %e, "failed to emit ssh-test-complete");
    }
    Ok(())
}

#[tauri::command]
async fn reconnect_session(app: tauri::AppHandle, repo_id: String) -> Result<(), String> {
    tracing::info!(repo_id = %repo_id, "reconnect_session called");
    let ssh_sessions = app.state::<ActiveSshSessions>();
    let notify = {
        let guard = ssh_sessions.sessions.lock().unwrap();
        guard.get(&repo_id).cloned()
    };
    match notify {
        Some(n) => {
            n.notify_one();
            tracing::info!(repo_id = %repo_id, "reconnect_session: notify sent");
            Ok(())
        }
        None => {
            tracing::warn!(repo_id = %repo_id, "reconnect_session: no active SSH session found");
            Err(format!("No active SSH session for repo {repo_id}"))
        }
    }
}

fn parse_rev_list_output(output: &str) -> (Option<u32>, Option<u32>) {
    let trimmed = output.trim();
    let parts: Vec<&str> = trimmed.split('\t').collect();
    if parts.len() == 2 {
        if let (Ok(ahead), Ok(behind)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>()) {
            return (Some(ahead), Some(behind));
        }
    }
    (None, None)
}

fn count_porcelain_lines(output: &str) -> u32 {
    output
        .lines()
        .filter(|line| !line.trim().is_empty())
        .count() as u32
}

fn resolve_runtime(repo: &RepoType, ssh_env_cache: &SshEnvCache) -> (Box<dyn RuntimeProvider>, PathBuf) {
    match repo {
        RepoType::Local { path } => (default_runtime(), PathBuf::from(path)),
        RepoType::Ssh { ssh_host, remote_path } => {
            (Box::new(SshRuntime::new(ssh_host, remote_path, ssh_env_cache.cache_ref())), PathBuf::from(remote_path))
        }
    }
}

fn generate_branch_name(plan_file: &str) -> String {
    let stem = Path::new(plan_file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "session".to_string());
    let slug = oneshot::slugify(&stem);
    let short_id = oneshot::generate_short_id();
    format!("yarr/{slug}-{short_id}")
}

#[tauri::command]
async fn get_repo_git_status(app: tauri::AppHandle, repo: RepoType, fetch: bool) -> Result<RepoGitStatus, String> {
    tracing::info!(repo_type = ?repo, fetch = fetch, "get_repo_git_status called");
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());

    // Optionally fetch from origin (non-fatal on failure)
    if fetch {
        let fetch_timeout = std::time::Duration::from_secs(60);
        match rt.run_command("git fetch origin", &working_dir, fetch_timeout).await {
            Ok(output) if output.exit_code != 0 => {
                tracing::warn!(stderr = %output.stderr, "git fetch origin failed (non-fatal)");
            }
            Err(e) => {
                tracing::warn!(error = %e, "git fetch origin failed (non-fatal)");
            }
            _ => {}
        }
    }

    let timeout = std::time::Duration::from_secs(30);

    // Get dirty file count
    let status_output = rt
        .run_command("git status --porcelain", &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if status_output.exit_code != 0 {
        return Err(status_output.stderr);
    }

    let dirty_count = count_porcelain_lines(&status_output.stdout);

    // Get ahead/behind counts (non-fatal if no upstream)
    let rev_list_result = rt
        .run_command("git rev-list --left-right --count HEAD...@{upstream}", &working_dir, timeout)
        .await;

    let (ahead, behind) = match rev_list_result {
        Ok(output) if output.exit_code == 0 => parse_rev_list_output(&output.stdout),
        _ => (None, None),
    };

    // Get current branch name
    let branch_output = rt
        .run_command("git branch --show-current", &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if branch_output.exit_code != 0 {
        return Err(branch_output.stderr);
    }

    let branch_name = branch_output.stdout.trim().to_string();

    Ok(RepoGitStatus {
        branch_name,
        dirty_count,
        ahead,
        behind,
    })
}

#[tauri::command]
async fn list_local_branches(app: tauri::AppHandle, repo: RepoType) -> Result<Vec<String>, String> {
    tracing::info!(repo_type = ?repo, "list_local_branches called");
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    let timeout = std::time::Duration::from_secs(30);

    let output = rt
        .run_command("git branch --format='%(refname:short)'", &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if output.exit_code != 0 {
        return Err(output.stderr);
    }

    let branches: Vec<String> = output
        .stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    tracing::debug!(count = branches.len(), "list_local_branches succeeded");
    Ok(branches)
}

#[tauri::command]
async fn switch_branch(app: tauri::AppHandle, repo: RepoType, branch: String) -> Result<(), String> {
    tracing::info!(branch = %branch, repo_type = ?repo, "switch_branch called");
    if !branch.chars().all(|c| c.is_alphanumeric() || "-_./".contains(c)) {
        return Err("Invalid branch name".to_string());
    }

    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    let timeout = std::time::Duration::from_secs(30);

    let output = rt
        .run_command(&format!("git checkout {branch}"), &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if output.exit_code != 0 {
        return Err(output.stderr);
    }

    tracing::info!(branch = %branch, "switch_branch succeeded");
    Ok(())
}

#[tauri::command]
async fn fast_forward_branch(app: tauri::AppHandle, repo: RepoType) -> Result<(), String> {
    tracing::info!(repo_type = ?repo, "fast_forward_branch called");
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    let fetch_timeout = std::time::Duration::from_secs(60);

    let fetch_output = rt
        .run_command("git fetch origin", &working_dir, fetch_timeout)
        .await
        .map_err(|e| e.to_string())?;

    if fetch_output.exit_code != 0 {
        return Err(fetch_output.stderr);
    }

    let timeout = std::time::Duration::from_secs(30);
    let merge_output = rt
        .run_command("git merge --ff-only @{upstream}", &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if merge_output.exit_code != 0 {
        return Err(merge_output.stderr);
    }

    tracing::info!("fast_forward_branch succeeded");
    Ok(())
}

pub(crate) async fn list_plans_impl(
    rt: &dyn RuntimeProvider,
    working_dir: &Path,
    plans_dir: &str,
) -> Result<Vec<String>, String> {
    let escaped_path = ssh_shell_escape(plans_dir);
    // Use -exec basename instead of -printf for macOS (BSD find) compatibility.
    // pipefail ensures find errors propagate through the pipe to sort.
    let cmd = format!(
        "set -o pipefail && find {} -maxdepth 1 -name '*.md' -type f -exec basename {{}} \\; | sort",
        escaped_path
    );
    tracing::info!(cmd = %cmd, working_dir = %working_dir.display(), "list_plans_impl running command");
    let timeout = std::time::Duration::from_secs(30);
    let output = rt
        .run_command(&cmd, working_dir, timeout)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "list_plans_impl run_command error");
            e.to_string()
        })?;

    tracing::debug!(
        exit_code = output.exit_code,
        stdout_len = output.stdout.len(),
        stderr = %output.stderr,
        "list_plans_impl command result"
    );

    if output.exit_code != 0 {
        tracing::warn!(exit_code = output.exit_code, stderr = %output.stderr, "list_plans_impl non-zero exit code, returning empty");
        return Ok(vec![]);
    }

    let files: Vec<String> = output
        .stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();

    if files.is_empty() && !output.stderr.is_empty() {
        tracing::warn!(stderr = %output.stderr, "list_plans_impl found 0 plans but stderr was non-empty");
    }
    tracing::debug!(files = ?files, "list_plans_impl parsed files");
    Ok(files)
}

#[tauri::command]
async fn list_plans(app: tauri::AppHandle, repo: RepoType, plans_dir: String) -> Result<Vec<String>, String> {
    tracing::info!(plans_dir = %plans_dir, repo = ?repo, "list_plans called");
    if plans_dir.contains("..") {
        tracing::warn!(plans_dir = %plans_dir, "list_plans rejected: path contains '..'");
        return Err("Invalid plans directory".to_string());
    }
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    tracing::info!(runtime = %rt.name(), working_dir = %working_dir.display(), "list_plans resolved runtime");
    match list_plans_impl(rt.as_ref(), &working_dir, &plans_dir).await {
        Ok(plans) => {
            tracing::info!(count = plans.len(), "list_plans succeeded");
            Ok(plans)
        }
        Err(e) => {
            tracing::error!(error = %e, "list_plans failed");
            Err(e)
        }
    }
}

pub(crate) async fn move_plan_to_completed_impl(
    rt: &dyn RuntimeProvider,
    working_dir: &Path,
    plans_dir: &str,
    filename: &str,
    commit: bool,
) -> Result<(), String> {
    tracing::info!(plans_dir = %plans_dir, filename = %filename, "move_plan_to_completed_impl called");
    let escaped_plans_dir = ssh_shell_escape(plans_dir);
    let escaped_filename = ssh_shell_escape(filename);
    let cmd = format!(
        "mkdir -p {escaped_plans_dir}/completed && mv {escaped_plans_dir}/{escaped_filename} {escaped_plans_dir}/completed/{escaped_filename}"
    );
    let timeout = std::time::Duration::from_secs(30);
    let output = rt
        .run_command(&cmd, working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if output.exit_code != 0 {
        tracing::error!(stderr = %output.stderr, plans_dir = %plans_dir, filename = %filename, "move_plan_to_completed_impl failed");
        return Err(output.stderr);
    }

    tracing::info!(plans_dir = %plans_dir, filename = %filename, "plan moved to completed");

    // Git add both old (deleted) and new (added) paths
    let add_cmd = format!(
        "git add {escaped_plans_dir}/{escaped_filename} {escaped_plans_dir}/completed/{escaped_filename}"
    );
    let add_output = rt.run_command(&add_cmd, working_dir, timeout).await;
    if let Ok(output) = &add_output {
        if output.exit_code != 0 {
            tracing::warn!(stderr = %output.stderr, "git add for completed plan failed");
            return Ok(()); // Move succeeded, git commit is best-effort
        }
    } else {
        tracing::warn!("git add command failed for completed plan");
        return Ok(());
    }

    if commit {
        // Commit
        let commit_msg = ssh_shell_escape(&format!("move plan to completed: {}", filename));
        let commit_cmd = format!("git commit -m {commit_msg} --no-verify");
        let commit_output = rt.run_command(&commit_cmd, working_dir, timeout).await;
        if let Ok(output) = &commit_output {
            if output.exit_code != 0 {
                tracing::warn!(stderr = %output.stderr, "git commit for completed plan failed");
                return Ok(());
            }
        } else {
            tracing::warn!("git commit command failed for completed plan");
            return Ok(());
        }

        tracing::info!(filename = %filename, "committed completed plan");

        // Push (best-effort)
        let push_output = rt.run_command("git push", working_dir, timeout).await;
        match push_output {
            Ok(output) if output.exit_code == 0 => {
                tracing::info!(filename = %filename, "pushed completed plan");
            }
            Ok(output) => {
                tracing::warn!(stderr = %output.stderr, filename = %filename, "git push for completed plan failed (will need manual push)");
            }
            Err(e) => {
                tracing::warn!(error = %e, filename = %filename, "git push command failed for completed plan");
            }
        }
    }

    Ok(())
}

#[tauri::command]
async fn move_plan_to_completed(app: tauri::AppHandle, repo: RepoType, plans_dir: String, filename: String) -> Result<(), String> {
    tracing::info!(repo = ?repo, plans_dir = %plans_dir, filename = %filename, "move_plan_to_completed called");
    if plans_dir.contains("..") {
        tracing::warn!(plans_dir = %plans_dir, "move_plan_to_completed rejected: plans_dir contains '..'");
        return Err("Invalid plans directory".to_string());
    }
    if filename.contains('/') || filename.contains("..") {
        tracing::warn!(filename = %filename, "move_plan_to_completed rejected: invalid filename");
        return Err("Invalid filename".to_string());
    }
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    move_plan_to_completed_impl(rt.as_ref(), &working_dir, &plans_dir, &filename, true).await
}

#[tauri::command]
async fn export_default_prompt(app: tauri::AppHandle, repo: RepoType, prompt_type: String) -> Result<String, String> {
    tracing::info!(repo = ?repo, prompt_type = %prompt_type, "export_default_prompt called");
    let (file_path, content) = prompt::export_prompt_details(&prompt_type)?;
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    let timeout = std::time::Duration::from_secs(30);

    let mkdir_output = rt.run_command("mkdir -p .yarr/prompts", &working_dir, timeout).await
        .map_err(|e| format!("Failed to create directory: {e}"))?;
    if mkdir_output.exit_code != 0 {
        return Err(format!("Failed to create .yarr/prompts directory: {}", mkdir_output.stderr));
    }

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(content);
    let write_cmd = format!("echo '{}' | base64 -d > {}", encoded, file_path);
    let output = rt.run_command(&write_cmd, &working_dir, timeout).await
        .map_err(|e| format!("Failed to write prompt file: {e}"))?;

    if output.exit_code != 0 {
        return Err(format!("Failed to write prompt file: {}", output.stderr));
    }

    tracing::info!(prompt_type = %prompt_type, file_path = %file_path, "default prompt exported successfully");
    Ok(file_path.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Force a webview to repaint by briefly resizing and restoring the window.
/// This works around a WebView2 bug on Windows where the rendering surface
/// goes blank after laptop sleep/resume.
fn force_webview_repaint(window: &WebviewWindow) {
    if let Ok(size) = window.outer_size() {
        let tweaked = tauri::PhysicalSize::new(size.width, size.height.wrapping_add(1));
        let _ = window.set_size(tauri::Size::Physical(tweaked));
        let original = tauri::PhysicalSize::new(size.width, size.height);
        let _ = window.set_size(tauri::Size::Physical(original));
    }
}

pub fn run() {
    let log_level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);

    tracing::info!(log_level = %log_level, "yarr starting up");

    let app = tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: None,
                    }),
                ])
                .max_file_size(5_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .level(log_level)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .setup(|_app| {
            tracing::info!("plugins initialized");
            Ok(())
        })
        .manage(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        })
        .manage(ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        })
        .manage(GlobalAbortRegistry {
            inner: std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
        })
        .manage(SshEnvCache::default())
        .invoke_handler(tauri::generate_handler![run_session, run_oneshot, resume_oneshot, stop_session, get_active_sessions, test_ssh_connection_steps, reconnect_session, list_traces, list_latest_traces, get_trace, get_trace_events, read_file_preview, get_repo_git_status, list_local_branches, switch_branch, fast_forward_branch, list_plans, move_plan_to_completed, export_default_prompt])
        .build(tauri::generate_context!())
        .expect("error building tauri application");

    tracing::info!("managed state initialized; app build succeeded; entering run loop");

    app.run(|app, event| {
        // Force webview repaint after sleep/resume to avoid blank screen (WebView2 bug on Windows).
        if let RunEvent::Resumed = event {
            tracing::info!("app resumed from sleep — forcing webview repaint");
            if let Some(window) = app.get_webview_window("main") {
                force_webview_repaint(&window);
            }
        }
        if let RunEvent::Exit = event {
            // Cancel all cancellation tokens
            let active = app.state::<ActiveSessions>();
            if let Ok(guard) = active.tokens.try_lock() {
                for (repo_id, handle) in guard.iter() {
                    tracing::info!("Cancelling session for repo {repo_id} on exit");
                    handle.cancel_token.cancel();
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
    use crate::runtime::{CommandOutput, MockRuntime};
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
                plan_file: Some("docs/plans/test.md".to_string()),
            },
        };

        let cloned = event.clone();

        let json_original =
            serde_json::to_string(&event).expect("serialization should succeed");
        let json_cloned =
            serde_json::to_string(&cloned).expect("serialization should succeed");

        assert_eq!(json_original, json_cloned);

        // Verify the serialized JSON contains the plan_file field
        assert!(
            json_original.contains("\"plan_file\":\"docs/plans/test.md\""),
            "serialized JSON should contain plan_file field, got: {}",
            json_original
        );
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
            effort_level: "medium".to_string(),
            design_effort_level: "high".to_string(),
            merge_strategy: MergeStrategy::MergeToMain,
            env_vars: env,
            max_iterations: 20,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            checks: vec![],
            git_sync: None,
            plans_dir: "docs/plans/".to_string(),
            ssh_host: None,
            move_plans_to_completed: true,
            design_prompt_file: None,
            implementation_prompt_file: None,
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
                parent_repo_id: "repo-1".to_string(),
                prompt: "Add feature X".to_string(),
                merge_strategy: "merge_to_main".to_string(),
                worktree_path: "/tmp/worktrees/repo-1".to_string(),
                branch: "yarr/add-feature-x-abc123".to_string(),
            },
        };
        let json = serde_json::to_value(&event).expect("serialization should succeed");
        assert_eq!(json["repo_id"], "repo-1");
        assert_eq!(json["event"]["kind"], "one_shot_started");
        assert_eq!(json["event"]["title"], "Add feature X");
        assert_eq!(json["event"]["merge_strategy"], "merge_to_main");
        assert_eq!(json["event"]["worktree_path"], "/tmp/worktrees/repo-1");
        assert_eq!(json["event"]["branch"], "yarr/add-feature-x-abc123");

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

    // --- GitSyncConfig deserialization tests ---

    #[test]
    fn git_sync_config_deserializes_from_camel_case_json() {
        let json = r#"{ "enabled": true, "conflictPrompt": "custom prompt", "model": "opus", "maxPushRetries": 5 }"#;
        let config: session::GitSyncConfig =
            serde_json::from_str(json).expect("deserialization should succeed");
        assert!(config.enabled);
        assert_eq!(config.conflict_prompt.as_deref(), Some("custom prompt"));
        assert_eq!(config.model.as_deref(), Some("opus"));
        assert_eq!(config.max_push_retries, 5);
    }

    #[test]
    fn git_sync_config_deserializes_with_defaults_from_empty_object() {
        let json = r#"{}"#;
        let config: session::GitSyncConfig =
            serde_json::from_str(json).expect("deserialization of empty object should succeed");
        assert!(!config.enabled);
        assert!(config.conflict_prompt.is_none());
        assert!(config.model.is_none());
        assert_eq!(config.max_push_retries, 3);
    }

    #[test]
    fn git_sync_config_deserializes_with_partial_fields() {
        let json = r#"{ "enabled": false }"#;
        let config: session::GitSyncConfig =
            serde_json::from_str(json).expect("deserialization with only enabled should succeed");
        assert!(!config.enabled);
        assert!(config.conflict_prompt.is_none());
        assert!(config.model.is_none());
        assert_eq!(config.max_push_retries, 3);
    }

    #[test]
    fn git_sync_config_option_none_is_valid() {
        let config: Option<session::GitSyncConfig> = None;
        assert!(config.is_none());

        // Also verify that JSON null deserializes to None
        let json = r#"null"#;
        let config: Option<session::GitSyncConfig> =
            serde_json::from_str(json).expect("null should deserialize to None");
        assert!(config.is_none());
    }

    #[test]
    fn git_sync_config_round_trip() {
        let original = session::GitSyncConfig {
            enabled: true,
            conflict_prompt: Some("resolve conflicts carefully".to_string()),
            model: Some("sonnet".to_string()),
            max_push_retries: 7,
        };

        let serialized = serde_json::to_string(&original).expect("serialization should succeed");
        let deserialized: session::GitSyncConfig =
            serde_json::from_str(&serialized).expect("deserialization should succeed");

        assert_eq!(deserialized.enabled, original.enabled);
        assert_eq!(deserialized.conflict_prompt, original.conflict_prompt);
        assert_eq!(deserialized.model, original.model);
        assert_eq!(deserialized.max_push_retries, original.max_push_retries);
    }

    // --- parse_rev_list_output tests ---

    #[test]
    fn parse_rev_list_output_normal() {
        let result = parse_rev_list_output("3\t5\n");
        assert_eq!(result, (Some(3), Some(5)));
    }

    #[test]
    fn parse_rev_list_output_zero_values() {
        let result = parse_rev_list_output("0\t0\n");
        assert_eq!(result, (Some(0), Some(0)));
    }

    #[test]
    fn parse_rev_list_output_only_ahead() {
        let result = parse_rev_list_output("2\t0\n");
        assert_eq!(result, (Some(2), Some(0)));
    }

    #[test]
    fn parse_rev_list_output_only_behind() {
        let result = parse_rev_list_output("0\t7\n");
        assert_eq!(result, (Some(0), Some(7)));
    }

    #[test]
    fn parse_rev_list_output_empty_string() {
        let result = parse_rev_list_output("");
        assert_eq!(result, (None, None));
    }

    #[test]
    fn parse_rev_list_output_malformed() {
        let result = parse_rev_list_output("not-a-number\n");
        assert_eq!(result, (None, None));
    }

    #[test]
    fn parse_rev_list_output_single_value() {
        let result = parse_rev_list_output("42\n");
        assert_eq!(result, (None, None));
    }

    #[test]
    fn parse_rev_list_output_three_fields() {
        let result = parse_rev_list_output("1\t2\t3\n");
        assert_eq!(result, (None, None));
    }

    #[test]
    fn parse_rev_list_output_non_numeric_pair() {
        let result = parse_rev_list_output("abc\tdef\n");
        assert_eq!(result, (None, None));
    }

    // --- generate_branch_name tests ---

    #[test]
    fn generate_branch_name_simple_plan_file() {
        let name = generate_branch_name("/home/user/docs/my-plan.md");
        // Should start with "yarr/"
        assert!(name.starts_with("yarr/"), "branch name should start with 'yarr/', got: {name}");
        // Should contain the slugified stem
        assert!(name.contains("my-plan"), "branch name should contain slug 'my-plan', got: {name}");
        // Format: yarr/{slug}-{6-char-id}
        let after_prefix = name.strip_prefix("yarr/").unwrap();
        // The last 7 characters should be "-" + 6 hex chars
        assert!(after_prefix.len() > 7, "branch name after prefix should be longer than 7 chars, got: {after_prefix}");
        let short_id = &after_prefix[after_prefix.len() - 6..];
        assert!(short_id.chars().all(|c: char| c.is_ascii_hexdigit()),
            "short_id should be hex characters, got: {short_id}");
        let separator = &after_prefix[after_prefix.len() - 7..after_prefix.len() - 6];
        assert_eq!(separator, "-", "slug and short_id should be separated by '-'");
    }

    #[test]
    fn generate_branch_name_nested_path_extracts_stem() {
        let name = generate_branch_name("/a/deeply/nested/path/to/feature-spec.md");
        assert!(name.starts_with("yarr/"), "branch name should start with 'yarr/', got: {name}");
        // Should contain only the file stem, not the path
        assert!(!name.contains("nested"), "branch name should not contain path components, got: {name}");
        assert!(!name.contains("path"), "branch name should not contain path components, got: {name}");
        assert!(name.contains("feature-spec"), "branch name should contain slugified file stem 'feature-spec', got: {name}");
    }

    #[test]
    fn generate_branch_name_special_characters_slugified() {
        let name = generate_branch_name("/home/user/My Cool Plan (v2)!.md");
        assert!(name.starts_with("yarr/"), "branch name should start with 'yarr/', got: {name}");
        // Slugified: special chars become hyphens, lowercased
        let after_prefix = name.strip_prefix("yarr/").unwrap();
        // The slug part (everything before the last 7 chars) should not contain uppercase or special chars
        let slug_part = &after_prefix[..after_prefix.len() - 7];
        assert!(slug_part.chars().all(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'),
            "slug should only contain lowercase alphanumeric and hyphens, got: {slug_part}");
    }

    #[test]
    fn generate_branch_name_produces_different_ids_on_successive_calls() {
        let name1 = generate_branch_name("/home/user/plan.md");
        let name2 = generate_branch_name("/home/user/plan.md");
        // The slugs should be the same but the short_ids should differ
        // (statistically certain with 6 hex chars = 16^6 = 16M possibilities)
        assert_ne!(name1, name2,
            "two calls with the same plan file should produce different branch names due to random short_id");
        // Both should have the same prefix up to the short_id
        let prefix1 = &name1[..name1.len() - 6];
        let prefix2 = &name2[..name2.len() - 6];
        assert_eq!(prefix1, prefix2,
            "the yarr/slug- prefix should be the same for both calls");
    }

    #[test]
    fn generate_branch_name_short_id_is_six_chars() {
        let name = generate_branch_name("/tmp/test.md");
        let after_prefix = name.strip_prefix("yarr/").unwrap();
        let short_id = &after_prefix[after_prefix.len() - 6..];
        assert_eq!(short_id.len(), 6, "short_id should be exactly 6 characters");
        assert!(short_id.chars().all(|c: char| c.is_ascii_hexdigit()),
            "short_id should be valid hex, got: {short_id}");
    }

    #[test]
    fn generate_branch_name_without_extension() {
        // Plan file with no extension
        let name = generate_branch_name("/home/user/plans/Makefile");
        assert!(name.starts_with("yarr/"), "branch name should start with 'yarr/', got: {name}");
        // The stem of "Makefile" is "Makefile", which slugifies to "makefile"
        let after_prefix = name.strip_prefix("yarr/").unwrap();
        let slug_part = &after_prefix[..after_prefix.len() - 7];
        assert_eq!(slug_part, "makefile", "slug for 'Makefile' should be 'makefile', got: {slug_part}");
    }

    // --- SshTestStep / connection_test_steps tests ---

    #[test]
    fn ssh_test_step_serializes_with_pass_status() {
        let step = SshTestStep {
            step: "SSH reachable".to_string(),
            status: "pass".to_string(),
            error: None,
        };

        let json = serde_json::to_value(&step).expect("serialization should succeed");

        assert_eq!(json["step"], "SSH reachable");
        assert_eq!(json["status"], "pass");
        assert!(json["error"].is_null(), "error should serialize as null when None");
    }

    #[test]
    fn ssh_test_step_serializes_with_fail_status_and_error() {
        let step = SshTestStep {
            step: "tmux available".to_string(),
            status: "fail".to_string(),
            error: Some("tmux not found on remote host".to_string()),
        };

        let json = serde_json::to_value(&step).expect("serialization should succeed");

        assert_eq!(json["step"], "tmux available");
        assert_eq!(json["status"], "fail");
        assert_eq!(json["error"], "tmux not found on remote host");
    }

    #[test]
    fn connection_test_steps_returns_four_steps() {
        let steps = connection_test_steps("myhost", "/home/user/project");
        assert_eq!(steps.len(), 4, "should return exactly 4 test steps");
    }

    #[test]
    fn connection_test_steps_first_step_is_ssh_reachable() {
        let steps = connection_test_steps("myhost", "/home/user/project");
        let (name, cmd) = &steps[0];

        assert_eq!(name, "SSH reachable", "first step should be 'SSH reachable'");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("echo OK"),
            "SSH reachable command should contain 'echo OK', got: {all_args}"
        );

        // Step 1 should use ssh_command_raw (no login shell wrapping)
        assert!(
            !all_args.contains("$SHELL -lc"),
            "SSH reachable should use ssh_command_raw (no login shell), but found '$SHELL -lc' in: {all_args}"
        );
    }

    #[test]
    fn connection_test_steps_second_step_is_tmux_available() {
        let steps = connection_test_steps("myhost", "/home/user/project");
        let (name, cmd) = &steps[1];

        assert_eq!(name, "tmux available", "second step should be 'tmux available'");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("command -v tmux"),
            "tmux check command should contain 'command -v tmux', got: {all_args}"
        );

        // Step 2 should use ssh_command (login shell wrapping) to find tmux via PATH
        assert!(
            all_args.contains("$SHELL -lc"),
            "tmux available should use ssh_command (login shell), but '$SHELL -lc' not found in: {all_args}"
        );
    }

    #[test]
    fn connection_test_steps_third_step_is_claude_available() {
        let steps = connection_test_steps("myhost", "/home/user/project");
        let (name, cmd) = &steps[2];

        assert_eq!(name, "claude available", "third step should be 'claude available'");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("command -v claude"),
            "claude check command should contain 'command -v claude', got: {all_args}"
        );

        // Step 3 should use ssh_command (login shell wrapping) to find claude via PATH
        assert!(
            all_args.contains("$SHELL -lc"),
            "claude available should use ssh_command (login shell), but '$SHELL -lc' not found in: {all_args}"
        );
    }

    #[test]
    fn connection_test_steps_fourth_step_checks_remote_path() {
        let steps = connection_test_steps("myhost", "/home/user/project");
        let (name, cmd) = &steps[3];

        assert_eq!(name, "Remote path exists", "fourth step should be 'Remote path exists'");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("test -d"),
            "remote path check command should contain 'test -d', got: {all_args}"
        );
        assert!(
            all_args.contains("/home/user/project"),
            "remote path check command should contain the provided path, got: {all_args}"
        );

        // Step 4 should use ssh_command_raw (no login shell wrapping)
        assert!(
            !all_args.contains("$SHELL -lc"),
            "Remote path exists should use ssh_command_raw (no login shell), but found '$SHELL -lc' in: {all_args}"
        );
    }

    #[test]
    fn connection_test_steps_escapes_remote_path_with_spaces() {
        let steps = connection_test_steps("myhost", "/home/user/my project");
        let (name, cmd) = &steps[3];

        assert_eq!(name, "Remote path exists");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The path with spaces should be present in the command args (shell-escaped)
        assert!(
            all_args.contains("/home/user/my project") || all_args.contains("'/home/user/my project'"),
            "remote path check command should include path with spaces (possibly shell-escaped), got: {all_args}"
        );
    }

    #[test]
    fn connection_test_steps_trims_remote_path_whitespace() {
        let steps = connection_test_steps("myhost", "  /home/user/project  ");
        let (name, cmd) = &steps[3];

        assert_eq!(name, "Remote path exists");

        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The remote path should be trimmed (no leading/trailing whitespace)
        assert!(
            all_args.contains("/home/user/project"),
            "remote path check command should contain trimmed path '/home/user/project', got: {all_args}"
        );
        assert!(
            !all_args.contains("  /home/user/project"),
            "remote path should not have leading whitespace, got: {all_args}"
        );
        assert!(
            !all_args.contains("/home/user/project  "),
            "remote path should not have trailing whitespace, got: {all_args}"
        );
    }

    // --- list_plans_impl / move_plan_to_completed_impl tests (TDD) ---

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn list_plans_impl_returns_only_md_files() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("plans");
        std::fs::create_dir_all(&plans_path).expect("failed to create plans dir");

        // Create some .md files and a non-.md file
        std::fs::write(plans_path.join("alpha.md"), "# Alpha").unwrap();
        std::fs::write(plans_path.join("beta.md"), "# Beta").unwrap();
        std::fs::write(plans_path.join("notes.txt"), "not a plan").unwrap();
        std::fs::write(plans_path.join("readme.rs"), "fn main() {}").unwrap();

        let rt = default_runtime();
        let result = list_plans_impl(rt.as_ref(), dir.path(), "plans")
            .await
            .expect("list_plans_impl should succeed");

        assert!(result.contains(&"alpha.md".to_string()), "should contain alpha.md, got: {:?}", result);
        assert!(result.contains(&"beta.md".to_string()), "should contain beta.md, got: {:?}", result);
        assert!(!result.contains(&"notes.txt".to_string()), "should not contain notes.txt");
        assert!(!result.contains(&"readme.rs".to_string()), "should not contain readme.rs");
        assert_eq!(result.len(), 2, "should contain exactly 2 .md files");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn list_plans_impl_excludes_files_in_subdirectories() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("plans");
        let completed_path = plans_path.join("completed");
        std::fs::create_dir_all(&completed_path).expect("failed to create completed dir");

        // Top-level plan files
        std::fs::write(plans_path.join("active.md"), "# Active").unwrap();
        // Completed plan files (in subdirectory -- should be excluded by maxdepth 1)
        std::fs::write(completed_path.join("done.md"), "# Done").unwrap();

        let rt = default_runtime();
        let result = list_plans_impl(rt.as_ref(), dir.path(), "plans")
            .await
            .expect("list_plans_impl should succeed");

        assert!(result.contains(&"active.md".to_string()), "should contain active.md");
        assert!(!result.contains(&"done.md".to_string()), "should not contain done.md from completed/");
        assert_eq!(result.len(), 1, "should contain exactly 1 file");
    }

    #[tokio::test]
    async fn list_plans_impl_returns_empty_vec_when_dir_missing() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        // Do NOT create the plans directory

        let rt = default_runtime();
        let result = list_plans_impl(rt.as_ref(), dir.path(), "nonexistent-plans")
            .await
            .expect("list_plans_impl should return Ok even when dir is missing");

        assert!(result.is_empty(), "should return empty vec when plans dir doesn't exist, got: {:?}", result);
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn list_plans_impl_returns_sorted_filenames() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("plans");
        std::fs::create_dir_all(&plans_path).expect("failed to create plans dir");

        // Create files in non-alphabetical order
        std::fs::write(plans_path.join("zebra.md"), "# Zebra").unwrap();
        std::fs::write(plans_path.join("alpha.md"), "# Alpha").unwrap();
        std::fs::write(plans_path.join("middle.md"), "# Middle").unwrap();

        let rt = default_runtime();
        let result = list_plans_impl(rt.as_ref(), dir.path(), "plans")
            .await
            .expect("list_plans_impl should succeed");

        assert_eq!(result, vec!["alpha.md", "middle.md", "zebra.md"],
            "files should be returned in sorted order");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn list_plans_impl_returns_filenames_without_directory_prefix() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("my-plans");
        std::fs::create_dir_all(&plans_path).expect("failed to create plans dir");

        std::fs::write(plans_path.join("feature.md"), "# Feature").unwrap();

        let rt = default_runtime();
        let result = list_plans_impl(rt.as_ref(), dir.path(), "my-plans")
            .await
            .expect("list_plans_impl should succeed");

        assert_eq!(result.len(), 1);
        // Should be just the filename, not a path like "my-plans/feature.md"
        assert_eq!(result[0], "feature.md",
            "should return bare filename without directory prefix");
        assert!(!result[0].contains('/'),
            "filename should not contain any path separators");
    }

    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn move_plan_to_completed_impl_moves_file_and_creates_dir() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("plans");
        std::fs::create_dir_all(&plans_path).expect("failed to create plans dir");

        // Create a plan file to move
        std::fs::write(plans_path.join("my-plan.md"), "# My Plan").unwrap();

        // completed/ directory does NOT exist yet -- impl should create it
        assert!(!plans_path.join("completed").exists(),
            "completed/ should not exist before the call");

        let rt = default_runtime();
        move_plan_to_completed_impl(rt.as_ref(), dir.path(), "plans", "my-plan.md", true)
            .await
            .expect("move_plan_to_completed_impl should succeed");

        // File should no longer be in the plans directory
        assert!(!plans_path.join("my-plan.md").exists(),
            "source file should no longer exist after move");

        // File should now be in the completed/ subdirectory
        assert!(plans_path.join("completed").join("my-plan.md").exists(),
            "file should exist in plans/completed/ after move");

        // Verify contents are preserved
        let content = std::fs::read_to_string(plans_path.join("completed").join("my-plan.md"))
            .expect("should be able to read moved file");
        assert_eq!(content, "# My Plan", "file contents should be preserved after move");
    }

    #[tokio::test]
    async fn move_plan_to_completed_impl_fails_for_nonexistent_file() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");
        let plans_path = dir.path().join("plans");
        std::fs::create_dir_all(&plans_path).expect("failed to create plans dir");

        // Do NOT create the file -- it doesn't exist
        let rt = default_runtime();
        let result = move_plan_to_completed_impl(rt.as_ref(), dir.path(), "plans", "nonexistent.md", true)
            .await;

        assert!(result.is_err(),
            "should return Err when source file does not exist");
    }

    #[tokio::test]
    async fn move_plan_to_completed_impl_commits_and_pushes() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. mv succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git add succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. git commit succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 4. git push succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let result =
            move_plan_to_completed_impl(&runtime, dir.path(), "plans", "my-plan.md", true).await;

        assert!(
            result.is_ok(),
            "should return Ok when mv, git add, commit, and push all succeed"
        );
    }

    #[tokio::test]
    async fn move_plan_to_completed_impl_ok_when_git_add_fails() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. mv succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git add fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "git add failed".to_string(),
            },
        ];

        let result =
            move_plan_to_completed_impl(&runtime, dir.path(), "plans", "my-plan.md", true).await;

        assert!(
            result.is_ok(),
            "should return Ok even when git add fails — git steps are best-effort"
        );
    }

    #[tokio::test]
    async fn move_plan_to_completed_impl_ok_when_push_fails() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. mv succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 2. git add succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. git commit succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 4. git push fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "push rejected".to_string(),
            },
        ];

        let result =
            move_plan_to_completed_impl(&runtime, dir.path(), "plans", "my-plan.md", true).await;

        assert!(
            result.is_ok(),
            "should return Ok even when git push fails — git steps are best-effort"
        );
    }

    #[tokio::test]
    async fn move_plan_to_completed_impl_mv_fails_returns_err() {
        let dir = tempfile::tempdir().expect("failed to create temp dir");

        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. mv fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "No such file or directory".to_string(),
            },
        ];

        let result =
            move_plan_to_completed_impl(&runtime, dir.path(), "plans", "nonexistent.md", true).await;

        assert!(
            result.is_err(),
            "should return Err when the mv command itself fails"
        );
    }

    // --- OneShotResult tests ---

    #[test]
    fn oneshot_result_serializes_with_oneshot_id() {
        let result = OneShotResult {
            oneshot_id: "oneshot-a1b2c3".to_string(),
            session_id: "sess-test".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(json.get("oneshot_id").is_some(), "JSON should contain 'oneshot_id' field");
        assert_eq!(json["oneshot_id"], "oneshot-a1b2c3");
    }

    #[test]
    fn oneshot_result_clone_produces_equal_json() {
        let result = OneShotResult {
            oneshot_id: "oneshot-d4e5f6".to_string(),
            session_id: "sess-test".to_string(),
        };

        let cloned = result.clone();

        let json_original =
            serde_json::to_string(&result).expect("serialization should succeed");
        let json_cloned =
            serde_json::to_string(&cloned).expect("serialization should succeed");

        assert_eq!(json_original, json_cloned,
            "cloned OneShotResult should serialize to identical JSON");
    }

    #[test]
    fn oneshot_result_oneshot_id_is_string() {
        let result = OneShotResult {
            oneshot_id: "oneshot-aabbcc".to_string(),
            session_id: "sess-test".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(json["oneshot_id"].is_string(),
            "oneshot_id should serialize as a JSON string, got: {:?}", json["oneshot_id"]);
    }

    #[test]
    fn tagged_event_with_oneshot_id() {
        let event = TaggedSessionEvent {
            repo_id: "oneshot-x1y2z3".to_string(),
            event: SessionEvent::OneShotStarted {
                title: "Fix bug".to_string(),
                parent_repo_id: "repo-original".to_string(),
                prompt: "Fix the login bug".to_string(),
                merge_strategy: "branch".to_string(),
                worktree_path: "/tmp/worktrees/repo-original".to_string(),
                branch: "yarr/fix-bug-x1y2z3".to_string(),
            },
        };

        let json = serde_json::to_value(&event).expect("serialization should succeed");

        assert_eq!(json["repo_id"], "oneshot-x1y2z3",
            "repo_id field should hold the oneshot ID");
        assert!(json["repo_id"].as_str().unwrap().starts_with("oneshot-"),
            "repo_id should start with 'oneshot-' prefix");
        assert_eq!(json["event"]["kind"], "one_shot_started");
        assert_eq!(json["event"]["title"], "Fix bug");
        assert_eq!(json["event"]["parent_repo_id"], "repo-original");
        assert_eq!(json["event"]["worktree_path"], "/tmp/worktrees/repo-original");
        assert_eq!(json["event"]["branch"], "yarr/fix-bug-x1y2z3");
    }

    // --- SessionHandle and ActiveSessions refactor tests ---

    #[tokio::test]
    async fn session_handle_stores_cancel_token_and_session_id() {
        let token = CancellationToken::new();
        let cloned_token = token.clone();
        let handle = SessionHandle {
            cancel_token: token,
            session_id: "sess-abc".to_string(),
            join_handle: tokio::spawn(async {}),
        };

        assert_eq!(handle.session_id, "sess-abc");
        assert!(!handle.cancel_token.is_cancelled());

        cloned_token.cancel();
        assert!(handle.cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn active_sessions_stores_and_retrieves_session_handle() {
        let active = ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        };

        let handle = SessionHandle {
            cancel_token: CancellationToken::new(),
            session_id: "sess-42".to_string(),
            join_handle: tokio::spawn(async {}),
        };

        active
            .tokens
            .lock()
            .await
            .insert("repo-x".to_string(), handle);

        let lock = active.tokens.lock().await;
        let retrieved = lock.get("repo-x").expect("should find the inserted handle");
        assert_eq!(retrieved.session_id, "sess-42");
        assert!(!retrieved.cancel_token.is_cancelled());
    }

    #[tokio::test]
    async fn active_sessions_get_returns_repo_and_session_id_pairs() {
        let active = ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        };

        {
            let mut lock = active.tokens.lock().await;
            lock.insert(
                "repo-alpha".to_string(),
                SessionHandle {
                    cancel_token: CancellationToken::new(),
                    session_id: "sess-1".to_string(),
                    join_handle: tokio::spawn(async {}),
                },
            );
            lock.insert(
                "repo-beta".to_string(),
                SessionHandle {
                    cancel_token: CancellationToken::new(),
                    session_id: "sess-2".to_string(),
                    join_handle: tokio::spawn(async {}),
                },
            );
            lock.insert(
                "repo-gamma".to_string(),
                SessionHandle {
                    cancel_token: CancellationToken::new(),
                    session_id: "sess-3".to_string(),
                    join_handle: tokio::spawn(async {}),
                },
            );
        }

        // Mimic get_active_sessions: read out (repo_id, session_id) pairs
        let pairs: Vec<(String, String)> = active
            .tokens
            .lock()
            .await
            .iter()
            .map(|(repo_id, sh)| (repo_id.clone(), sh.session_id.clone()))
            .collect();

        assert_eq!(pairs.len(), 3);

        // Collect into a map for order-independent assertions
        let pair_map: HashMap<String, String> = pairs.into_iter().collect();
        assert_eq!(pair_map.get("repo-alpha").unwrap(), "sess-1");
        assert_eq!(pair_map.get("repo-beta").unwrap(), "sess-2");
        assert_eq!(pair_map.get("repo-gamma").unwrap(), "sess-3");
    }

    #[tokio::test]
    async fn stop_session_cancels_token_without_holding_lock() {
        let active = ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        };

        let token = CancellationToken::new();
        let token_for_handle = token.clone();

        active.tokens.lock().await.insert(
            "repo-lock-test".to_string(),
            SessionHandle {
                cancel_token: token_for_handle,
                session_id: "sess-lock".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Mimic the fixed stop_session pattern: clone token, drop lock, THEN cancel
        let cloned_token = {
            let lock = active.tokens.lock().await;
            let sh = lock.get("repo-lock-test").expect("should exist");
            sh.cancel_token.clone()
        };
        // Lock is now dropped — safe to cancel without risking deadlock

        assert!(!token.is_cancelled(), "token should not be cancelled yet");

        cloned_token.cancel();

        assert!(
            token.is_cancelled(),
            "original token should be cancelled after cloned token is cancelled"
        );

        // Verify the lock can still be acquired (proves it was dropped before cancel)
        let lock = active.tokens.lock().await;
        assert!(
            lock.get("repo-lock-test").is_some(),
            "entry should still be in the map"
        );
        assert!(
            lock.get("repo-lock-test").unwrap().cancel_token.is_cancelled(),
            "stored token should reflect cancellation"
        );
    }

    #[tokio::test]
    async fn stop_session_returns_error_for_unknown_repo() {
        let active = ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        };

        // Insert one session so the map isn't empty
        active.tokens.lock().await.insert(
            "repo-exists".to_string(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-exists".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Look up a repo_id that doesn't exist — mimics the error path in stop_session
        let lock = active.tokens.lock().await;
        let result = lock.get("repo-does-not-exist");
        assert!(
            result.is_none(),
            "looking up a non-existent repo_id should return None"
        );
    }

    // --- SessionResult tests (TDD — struct does not exist yet) ---

    #[test]
    fn session_result_serializes_with_session_id() {
        let result = SessionResult {
            session_id: "test-123".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(
            json.get("session_id").is_some(),
            "JSON should contain 'session_id' field"
        );
        assert_eq!(json["session_id"], "test-123");
        assert!(
            json["session_id"].is_string(),
            "session_id should serialize as a JSON string"
        );
    }

    #[test]
    fn session_result_clone_produces_equivalent_struct() {
        let result = SessionResult {
            session_id: "sess-clone-test".to_string(),
        };

        let cloned = result.clone();

        assert_eq!(
            result.session_id, cloned.session_id,
            "cloned SessionResult should have the same session_id"
        );

        let json_original =
            serde_json::to_string(&result).expect("serialization should succeed");
        let json_cloned =
            serde_json::to_string(&cloned).expect("serialization should succeed");

        assert_eq!(
            json_original, json_cloned,
            "cloned SessionResult should serialize to identical JSON"
        );
    }

    // --- Reject guard logic test ---

    #[tokio::test]
    async fn reject_guard_detects_existing_session_for_repo() {
        let active = ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        };

        // Pre-populate with an existing session for "repo-busy"
        active.tokens.lock().await.insert(
            "repo-busy".to_string(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-existing".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Simulate the reject guard check: if the repo_id already exists, reject
        let lock = active.tokens.lock().await;
        let already_running = lock.contains_key("repo-busy");
        assert!(
            already_running,
            "contains_key should return true for a repo with an active session"
        );

        // A different repo_id should not be rejected
        let not_running = lock.contains_key("repo-idle");
        assert!(
            !not_running,
            "contains_key should return false for a repo without an active session"
        );

        // Verify the expected error message the guard would produce
        let err_msg = if already_running {
            Err::<(), String>("Session already running for this repo".to_string())
        } else {
            Ok(())
        };
        assert!(err_msg.is_err());
        assert_eq!(
            err_msg.unwrap_err(),
            "Session already running for this repo"
        );
    }

    // --- Scope guard cleanup pattern test ---

    #[tokio::test]
    async fn scopeguard_cleanup_removes_entry_from_active_sessions() {
        use std::sync::Arc;

        let map = Arc::new(Mutex::new(HashMap::<String, String>::new()));

        // Insert an entry that should be cleaned up
        map.lock().await.insert("repo-cleanup".to_string(), "sess-temp".to_string());
        assert!(map.lock().await.contains_key("repo-cleanup"));

        // Simulate the scope guard pattern used in run_session:
        // when the guard goes out of scope, it removes the entry
        let map_clone = Arc::clone(&map);
        {
            let _guard = scopeguard::guard("repo-cleanup".to_string(), |repo_id| {
                // In production this would be: active_sessions.tokens.lock().await.remove(&repo_id)
                // Since scopeguard closures are sync, we use try_lock (works in tests
                // because no contention) to verify the pattern.
                if let Ok(mut lock) = map_clone.try_lock() {
                    lock.remove(&repo_id);
                }
            });
            // guard is alive here — entry should still be in the map
            assert!(
                map.lock().await.contains_key("repo-cleanup"),
                "entry should still exist while guard is alive"
            );
        }
        // guard has been dropped — cleanup should have fired

        assert!(
            !map.lock().await.contains_key("repo-cleanup"),
            "entry should be removed after scope guard cleanup"
        );
    }

    // --- SSH scope guard cleanup tests (spawn-and-return pattern) ---

    #[tokio::test]
    async fn test_ssh_scope_guard_cleans_up_both_registries() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });
        let active_ssh_sessions = Arc::new(ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        });

        let repo_id = "ssh-repo-cleanup".to_string();

        // Insert entries into both registries (mimics run_session SSH branch setup)
        active_sessions.tokens.lock().await.insert(
            repo_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-ssh-1".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );
        active_ssh_sessions
            .sessions
            .lock()
            .unwrap()
            .insert(repo_id.clone(), Arc::new(tokio::sync::Notify::new()));

        // Verify both registries have the entry
        assert!(active_sessions.tokens.lock().await.contains_key(&repo_id));
        assert!(active_ssh_sessions.sessions.lock().unwrap().contains_key(&repo_id));

        // Spawn a task with a scopeguard that cleans up both registries on exit
        let sessions_clone = Arc::clone(&active_sessions);
        let ssh_sessions_clone = Arc::clone(&active_ssh_sessions);
        let repo_id_clone = repo_id.clone();

        let handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone;
                let ssh_sessions = ssh_sessions_clone;
                let repo_id = repo_id_clone;
                move |_| {
                    ssh_sessions.sessions.lock().unwrap().remove(&repo_id);
                    // For ActiveSessions (tokio Mutex), we spawn a task since
                    // scopeguard closures are sync
                    let sessions = sessions;
                    let repo_id_inner = repo_id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&repo_id_inner);
                    });
                }
            });

            // Simulate some work inside the spawned task
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            // Task completes normally — guard fires on drop
        });

        // Wait for the spawned task to complete
        handle.await.expect("spawned task should complete without error");

        // Give the inner tokio::spawn (for ActiveSessions cleanup) a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify both registries are cleaned up
        assert!(
            !active_ssh_sessions.sessions.lock().unwrap().contains_key(&repo_id),
            "ActiveSshSessions should be cleaned up after task completes"
        );
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&repo_id),
            "ActiveSessions should be cleaned up after task completes"
        );
    }

    #[tokio::test]
    async fn test_ssh_scope_guard_cleans_up_on_panic() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });
        let active_ssh_sessions = Arc::new(ActiveSshSessions {
            sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
        });

        let repo_id = "ssh-repo-panic".to_string();

        // Insert entries into both registries
        active_sessions.tokens.lock().await.insert(
            repo_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-ssh-panic".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );
        active_ssh_sessions
            .sessions
            .lock()
            .unwrap()
            .insert(repo_id.clone(), Arc::new(tokio::sync::Notify::new()));

        // Verify both registries have the entry
        assert!(active_sessions.tokens.lock().await.contains_key(&repo_id));
        assert!(active_ssh_sessions.sessions.lock().unwrap().contains_key(&repo_id));

        // Spawn a task that panics — scopeguard should still fire during unwind
        let sessions_clone = Arc::clone(&active_sessions);
        let ssh_sessions_clone = Arc::clone(&active_ssh_sessions);
        let repo_id_clone = repo_id.clone();

        let handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone;
                let ssh_sessions = ssh_sessions_clone;
                let repo_id = repo_id_clone;
                move |_| {
                    ssh_sessions.sessions.lock().unwrap().remove(&repo_id);
                    let sessions = sessions;
                    let repo_id_inner = repo_id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&repo_id_inner);
                    });
                }
            });

            // Panic! The scope guard should still clean up.
            panic!("simulated SSH orchestrator failure");
        });

        // The JoinHandle returns Err because the task panicked
        let result = handle.await;
        assert!(result.is_err(), "task should have panicked");

        // Give the inner tokio::spawn (for ActiveSessions cleanup) a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify both registries are cleaned up despite the panic
        assert!(
            !active_ssh_sessions.sessions.lock().unwrap().contains_key(&repo_id),
            "ActiveSshSessions should be cleaned up even after panic"
        );
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&repo_id),
            "ActiveSessions should be cleaned up even after panic"
        );
    }

    // --- RepoGitStatus serialization tests ---

    #[test]
    fn repo_git_status_serializes_with_camel_case_fields() {
        let status = RepoGitStatus {
            branch_name: "main".to_string(),
            dirty_count: 3,
            ahead: Some(2),
            behind: Some(1),
        };

        let json = serde_json::to_value(&status).expect("serialization should succeed");

        assert_eq!(json["branchName"], "main",
            "branch_name should serialize as camelCase 'branchName'");
        assert_eq!(json["dirtyCount"], 3,
            "dirty_count should serialize as camelCase 'dirtyCount'");
        assert_eq!(json["ahead"], 2,
            "ahead should serialize as the numeric value when Some");
        assert_eq!(json["behind"], 1,
            "behind should serialize as the numeric value when Some");
    }

    #[test]
    fn repo_git_status_serializes_none_ahead_behind_as_null() {
        let status = RepoGitStatus {
            branch_name: "feature/test".to_string(),
            dirty_count: 0,
            ahead: None,
            behind: None,
        };

        let json = serde_json::to_value(&status).expect("serialization should succeed");

        assert_eq!(json["branchName"], "feature/test");
        assert_eq!(json["dirtyCount"], 0);
        assert!(json["ahead"].is_null(),
            "ahead should serialize as null when None");
        assert!(json["behind"].is_null(),
            "behind should serialize as null when None");
    }

    #[test]
    fn repo_git_status_does_not_have_snake_case_fields() {
        let status = RepoGitStatus {
            branch_name: "develop".to_string(),
            dirty_count: 1,
            ahead: Some(0),
            behind: None,
        };

        let json = serde_json::to_value(&status).expect("serialization should succeed");

        assert!(json.get("branch_name").is_none(),
            "snake_case 'branch_name' should not exist in serialized JSON");
        assert!(json.get("dirty_count").is_none(),
            "snake_case 'dirty_count' should not exist in serialized JSON");
    }

    #[test]
    fn repo_git_status_clone_produces_equal_json() {
        let status = RepoGitStatus {
            branch_name: "main".to_string(),
            dirty_count: 5,
            ahead: Some(1),
            behind: Some(3),
        };

        let cloned = status.clone();

        let json_original = serde_json::to_string(&status).expect("serialization should succeed");
        let json_cloned = serde_json::to_string(&cloned).expect("serialization should succeed");

        assert_eq!(json_original, json_cloned,
            "cloned RepoGitStatus should serialize to identical JSON");
    }

    // --- count_porcelain_lines tests ---

    #[test]
    fn count_porcelain_lines_empty_string() {
        let count = count_porcelain_lines("");
        assert_eq!(count, 0, "empty string should yield 0 lines");
    }

    #[test]
    fn count_porcelain_lines_single_modified_file() {
        let output = " M src/main.rs\n";
        let count = count_porcelain_lines(output);
        assert_eq!(count, 1, "single modified file should yield 1");
    }

    #[test]
    fn count_porcelain_lines_multiple_files() {
        let output = " M src/main.rs\n?? untracked.txt\nA  staged.rs\n";
        let count = count_porcelain_lines(output);
        assert_eq!(count, 3, "three files (modified, untracked, staged) should yield 3");
    }

    #[test]
    fn count_porcelain_lines_trailing_newline_no_double_count() {
        // Typical git output ends with a trailing newline
        let output = " M file1.rs\n M file2.rs\n";
        let count = count_porcelain_lines(output);
        assert_eq!(count, 2,
            "trailing newline should not cause a double-count, expected 2");
    }

    #[test]
    fn count_porcelain_lines_whitespace_only_lines_not_counted() {
        let output = " M file.rs\n   \n\n  \n";
        let count = count_porcelain_lines(output);
        assert_eq!(count, 1,
            "whitespace-only and empty lines should not be counted");
    }

    // --- 1-shot scope guard cleanup tests (Task 4) ---
    //
    // These tests validate that the scopeguard pattern correctly cleans up
    // ActiveSessions for the 1-shot spawn block. The 1-shot path only uses
    // ActiveSessions (unlike the SSH path which also uses ActiveSshSessions),
    // so cleanup must remove the oneshot_id from ActiveSessions on normal
    // completion, panic, and task abort.

    #[tokio::test]
    async fn test_oneshot_scope_guard_cleans_up_on_normal_completion() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let oneshot_id = "oneshot-normal-completion".to_string();

        // Insert a placeholder SessionHandle (mimics run_oneshot setup)
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-oneshot-1".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Verify entry exists before spawn
        assert!(
            active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should exist before the task runs"
        );

        // Spawn a task with the scope guard pattern matching the 1-shot block
        let sessions_clone = Arc::clone(&active_sessions);
        let oneshot_id_bg = oneshot_id.clone();

        let join_handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone.clone();
                let id = oneshot_id_bg.clone();
                move |_| {
                    let sessions = sessions.clone();
                    let id = id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&id);
                    });
                }
            });

            // Simulate the runner doing work and completing normally
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        });

        // Wait for the task to finish
        join_handle.await.expect("task should complete without error");

        // Give the inner tokio::spawn (cleanup) a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify the entry was cleaned up
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should be removed from ActiveSessions after normal completion"
        );
    }

    #[tokio::test]
    async fn test_oneshot_scope_guard_cleans_up_on_panic() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let oneshot_id = "oneshot-panic-cleanup".to_string();

        // Insert a placeholder SessionHandle
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-oneshot-panic".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        assert!(
            active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should exist before the task runs"
        );

        // Spawn a task that panics — the scope guard should still fire
        let sessions_clone = Arc::clone(&active_sessions);
        let oneshot_id_bg = oneshot_id.clone();

        let handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone.clone();
                let id = oneshot_id_bg.clone();
                move |_| {
                    let sessions = sessions.clone();
                    let id = id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&id);
                    });
                }
            });

            // Panic! Without scopeguard, the manual cleanup line would never execute.
            panic!("simulated oneshot runner failure");
        });

        // The JoinHandle returns Err because the task panicked
        let result = handle.await;
        assert!(result.is_err(), "task should have panicked");

        // Give the inner tokio::spawn (cleanup) a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify the entry was still cleaned up despite the panic
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should be removed from ActiveSessions even after panic"
        );
    }

    #[tokio::test]
    async fn test_oneshot_scope_guard_cleans_up_on_task_abort() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let oneshot_id = "oneshot-abort-cleanup".to_string();

        // Insert a placeholder SessionHandle
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-oneshot-abort".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        assert!(
            active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should exist before the task runs"
        );

        // Spawn a long-running task with the scope guard, then abort it
        let sessions_clone = Arc::clone(&active_sessions);
        let oneshot_id_bg = oneshot_id.clone();

        let handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone.clone();
                let id = oneshot_id_bg.clone();
                move |_| {
                    let sessions = sessions.clone();
                    let id = id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&id);
                    });
                }
            });

            // Simulate a long-running oneshot task that will be aborted
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        });

        // Let the task start running
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        // Abort the task (simulates what would happen if a user cancels)
        handle.abort();

        // Wait for the abort to take effect
        let result = handle.await;
        assert!(result.is_err(), "task should have been aborted");
        assert!(result.unwrap_err().is_cancelled(), "error should indicate cancellation");

        // Give the inner tokio::spawn (cleanup) a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // Verify the entry was cleaned up despite the abort
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should be removed from ActiveSessions even after task abort"
        );
    }

    #[tokio::test]
    async fn test_oneshot_join_handle_stored_back_into_active_sessions() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let oneshot_id = "oneshot-handle-update".to_string();
        let cancel_token = CancellationToken::new();

        // Insert a placeholder with a dummy join_handle (mimics the initial insert)
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: cancel_token.clone(),
                session_id: "sess-oneshot-handle".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Spawn the "real" background task (simulates the 1-shot runner task)
        let sessions_clone = Arc::clone(&active_sessions);
        let oneshot_id_bg = oneshot_id.clone();

        let join_handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone.clone();
                let id = oneshot_id_bg.clone();
                move |_| {
                    let sessions = sessions.clone();
                    let id = id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&id);
                    });
                }
            });

            // Simulate waiting for cancellation (like a real runner would)
            cancel_token.cancelled().await;
        });

        // Update the placeholder with the real JoinHandle
        // (this is the pattern that 1-shot should adopt from local/SSH paths)
        {
            let mut lock = active_sessions.tokens.lock().await;
            if let Some(handle) = lock.get_mut(&oneshot_id) {
                handle.join_handle = join_handle;
            }
        }

        // Verify the entry still exists and the session_id is preserved
        {
            let lock = active_sessions.tokens.lock().await;
            let handle = lock.get(&oneshot_id).expect("entry should still exist after update");
            assert_eq!(handle.session_id, "sess-oneshot-handle",
                "session_id should be preserved after JoinHandle update");
            assert!(!handle.join_handle.is_finished(),
                "real join_handle should still be running (waiting for cancellation)");
        }

        // Now cancel the token to let the task complete, which triggers the scope guard
        {
            let lock = active_sessions.tokens.lock().await;
            lock.get(&oneshot_id).unwrap().cancel_token.cancel();
        }

        // Give the task and cleanup spawn time to complete
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // Verify cleanup happened
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should be cleaned up after cancellation triggers scope guard"
        );
    }

    #[tokio::test]
    async fn test_oneshot_scope_guard_only_removes_its_own_entry() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let oneshot_id = "oneshot-target".to_string();
        let other_repo_id = "repo-other-session".to_string();

        // Insert two entries: one for the 1-shot, one for a regular session
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-oneshot-target".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );
        active_sessions.tokens.lock().await.insert(
            other_repo_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "sess-other".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        assert_eq!(active_sessions.tokens.lock().await.len(), 2,
            "should have two entries before the task runs");

        // Spawn a task with scope guard that only cleans up oneshot_id
        let sessions_clone = Arc::clone(&active_sessions);
        let oneshot_id_bg = oneshot_id.clone();

        let handle = tokio::spawn(async move {
            let _guard = scopeguard::guard((), {
                let sessions = sessions_clone.clone();
                let id = oneshot_id_bg.clone();
                move |_| {
                    let sessions = sessions.clone();
                    let id = id.clone();
                    tokio::spawn(async move {
                        sessions.tokens.lock().await.remove(&id);
                    });
                }
            });

            // Task completes immediately
        });

        handle.await.expect("task should complete without error");

        // Give the cleanup spawn a moment to run
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        // The oneshot entry should be removed
        assert!(
            !active_sessions.tokens.lock().await.contains_key(&oneshot_id),
            "oneshot entry should be removed"
        );

        // The other session should be untouched
        assert!(
            active_sessions.tokens.lock().await.contains_key(&other_repo_id),
            "other repo entry should remain in ActiveSessions"
        );
        assert_eq!(
            active_sessions.tokens.lock().await.get(&other_repo_id).unwrap().session_id,
            "sess-other",
            "other session's data should be untouched"
        );
    }

    // ── Error-path SessionComplete emission tests ──────────────────────

    #[test]
    fn session_complete_failed_with_plan_file_serializes_correctly() {
        let event = TaggedSessionEvent {
            repo_id: "repo-err".to_string(),
            event: SessionEvent::SessionComplete {
                outcome: SessionOutcome::Failed,
                plan_file: Some("docs/plans/my-plan.md".to_string()),
            },
        };

        let json = serde_json::to_value(&event).expect("serialization should succeed");

        assert_eq!(json["repo_id"], "repo-err");
        assert_eq!(json["event"]["kind"], "session_complete");
        assert_eq!(json["event"]["outcome"], "failed");
        assert_eq!(json["event"]["plan_file"], "docs/plans/my-plan.md");
    }

    #[test]
    fn session_complete_failed_without_plan_file_serializes_correctly() {
        let event = TaggedSessionEvent {
            repo_id: "repo-err-no-plan".to_string(),
            event: SessionEvent::SessionComplete {
                outcome: SessionOutcome::Failed,
                plan_file: None,
            },
        };

        let json = serde_json::to_value(&event).expect("serialization should succeed");

        assert_eq!(json["repo_id"], "repo-err-no-plan");
        assert_eq!(json["event"]["kind"], "session_complete");
        assert_eq!(json["event"]["outcome"], "failed");
        assert!(json["event"]["plan_file"].is_null(), "plan_file should be null when None");
    }

    #[tokio::test]
    async fn error_path_emits_session_complete_failed() {
        // Simulate the spawn-block pattern: a task runs a fallible operation,
        // and when it returns Err, a SessionComplete { outcome: Failed } event
        // is emitted through a shared callback channel.
        let (tx, rx) = std::sync::mpsc::channel::<SessionEvent>();
        let plan_file: Option<String> = None;

        let handle = tokio::spawn(async move {
            // Simulate runner.run() returning an error
            let result: Result<(), String> = Err("claude process crashed".to_string());

            if result.is_err() {
                let _ = tx.send(SessionEvent::SessionComplete {
                    outcome: SessionOutcome::Failed,
                    plan_file,
                });
            }
        });

        handle.await.expect("task should complete");

        let emitted = rx.try_recv().expect("should have received a SessionComplete event");
        match emitted {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(outcome, SessionOutcome::Failed);
                assert!(plan_file.is_none());
            }
            other => panic!("expected SessionComplete, got {:?}", other),
        }
    }

    // --- OneShotResult session_id tests (TDD — field does not exist yet) ---

    #[test]
    fn oneshot_result_serializes_with_session_id() {
        let result = OneShotResult {
            oneshot_id: "oneshot-a1b2c3".to_string(),
            session_id: "sess-abc123".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(
            json.get("session_id").is_some(),
            "JSON should contain 'session_id' field"
        );
        assert_eq!(json["session_id"], "sess-abc123");
    }

    #[test]
    fn oneshot_result_session_id_is_string() {
        let result = OneShotResult {
            oneshot_id: "oneshot-d4e5f6".to_string(),
            session_id: "sess-xyz789".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(
            json["session_id"].is_string(),
            "session_id should serialize as a JSON string, got: {:?}",
            json["session_id"]
        );
    }

    #[tokio::test]
    async fn error_path_emit_includes_plan_file_from_config() {
        // When the session config has a plan_file, the error-path emit should
        // carry that plan_file through to the SessionComplete event.
        let (tx, rx) = std::sync::mpsc::channel::<SessionEvent>();
        let plan_file = Some("docs/plans/fix-auth.md".to_string());

        let handle = tokio::spawn(async move {
            // Simulate runner.run() returning an error
            let result: Result<(), String> = Err("ssh connection refused".to_string());

            if result.is_err() {
                let _ = tx.send(SessionEvent::SessionComplete {
                    outcome: SessionOutcome::Failed,
                    plan_file,
                });
            }
        });

        handle.await.expect("task should complete");

        let emitted = rx.try_recv().expect("should have received a SessionComplete event");
        match emitted {
            SessionEvent::SessionComplete { outcome, plan_file } => {
                assert_eq!(outcome, SessionOutcome::Failed);
                assert_eq!(plan_file.as_deref(), Some("docs/plans/fix-auth.md"));
            }
            other => panic!("expected SessionComplete, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn success_path_does_not_double_emit_session_complete() {
        // When the inner operation succeeds, the error handler should NOT emit
        // an additional SessionComplete event. The runner itself already emits
        // SessionComplete on the success path (session.rs:877), so the
        // error-path handler must stay silent.
        let (tx, rx) = std::sync::mpsc::channel::<SessionEvent>();

        let handle = tokio::spawn(async move {
            // Simulate runner.run() returning Ok (success)
            let result: Result<(), String> = Ok(());

            if result.is_err() {
                // This should NOT execute on the success path
                let _ = tx.send(SessionEvent::SessionComplete {
                    outcome: SessionOutcome::Failed,
                    plan_file: None,
                });
            }
            // Explicitly drop tx so the channel closes
            drop(tx);
        });

        handle.await.expect("task should complete");

        // The channel should be empty — no SessionComplete was emitted by the error handler
        let recv_result = rx.try_recv();
        assert!(
            recv_result.is_err(),
            "no SessionComplete should be emitted on the success path, but got: {:?}",
            recv_result.ok()
        );
    }

    #[tokio::test]
    async fn test_detects_concurrent_ralph_loop_for_oneshot() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let repo_id = "my-repo".to_string();
        let oneshot_id = "oneshot-abc123".to_string();

        // Insert a ralph loop session keyed by repo_id
        active_sessions.tokens.lock().await.insert(
            repo_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "ralph-sess-1".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        // Insert a oneshot session keyed by oneshot_id
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "oneshot-sess-1".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        let sessions = active_sessions.tokens.lock().await;

        // Verify we can detect the concurrent ralph loop session
        assert!(
            sessions.contains_key(&repo_id),
            "should detect a ralph loop session for the repo"
        );

        // Verify we can retrieve the existing_session_id for logging
        let existing_handle = sessions.get(&repo_id).expect("ralph loop session should exist");
        assert_eq!(
            existing_handle.session_id, "ralph-sess-1",
            "should be able to retrieve the existing ralph loop session_id"
        );
    }

    #[tokio::test]
    async fn test_no_concurrent_session_detected_when_no_ralph_loop() {
        use std::sync::Arc;

        let active_sessions = Arc::new(ActiveSessions {
            tokens: Mutex::new(HashMap::new()),
        });

        let repo_id = "my-repo".to_string();
        let oneshot_id = "oneshot-abc123".to_string();

        // Insert only a oneshot session — no ralph loop for this repo
        active_sessions.tokens.lock().await.insert(
            oneshot_id.clone(),
            SessionHandle {
                cancel_token: CancellationToken::new(),
                session_id: "oneshot-sess-1".to_string(),
                join_handle: tokio::spawn(async {}),
            },
        );

        let sessions = active_sessions.tokens.lock().await;

        // Verify no ralph loop session is detected
        assert!(
            !sessions.contains_key(&repo_id),
            "should not detect a ralph loop session when none is running"
        );
    }

    // --- move_plan_to_completed_impl tests ---

    #[tokio::test]
    async fn test_move_plan_to_completed_with_commit_true() {
        let runtime = MockRuntime::completing_after(1);
        let working_dir = std::path::PathBuf::from("/fake/repo");

        let result = move_plan_to_completed_impl(
            &runtime,
            &working_dir,
            "docs/plans",
            "my-plan.md",
            true,
        )
        .await;

        assert!(result.is_ok(), "move_plan_to_completed_impl should succeed, got: {:?}", result);

        let commands = runtime.captured_commands.lock().unwrap();
        assert_eq!(
            commands.len(),
            4,
            "with commit=true, should issue 4 commands (mkdir+mv, git add, git commit, git push), got: {:?}",
            *commands
        );

        // 1. mkdir + mv
        assert!(
            commands[0].contains("mkdir -p") && commands[0].contains("mv"),
            "first command should be mkdir+mv, got: {}",
            commands[0]
        );

        // 2. git add
        assert!(
            commands[1].starts_with("git add"),
            "second command should be git add, got: {}",
            commands[1]
        );

        // 3. git commit
        assert!(
            commands[2].starts_with("git commit"),
            "third command should be git commit, got: {}",
            commands[2]
        );
        assert!(
            commands[2].contains("--no-verify"),
            "git commit should include --no-verify, got: {}",
            commands[2]
        );

        // 4. git push
        assert!(
            commands[3].contains("git push"),
            "fourth command should be git push, got: {}",
            commands[3]
        );
    }

    #[tokio::test]
    async fn test_move_plan_to_completed_with_commit_false() {
        let runtime = MockRuntime::completing_after(1);
        let working_dir = std::path::PathBuf::from("/fake/repo");

        let result = move_plan_to_completed_impl(
            &runtime,
            &working_dir,
            "docs/plans",
            "my-plan.md",
            false,
        )
        .await;

        assert!(result.is_ok(), "move_plan_to_completed_impl should succeed, got: {:?}", result);

        let commands = runtime.captured_commands.lock().unwrap();
        assert_eq!(
            commands.len(),
            2,
            "with commit=false, should issue only 2 commands (mkdir+mv, git add), got: {:?}",
            *commands
        );

        // 1. mkdir + mv
        assert!(
            commands[0].contains("mkdir -p") && commands[0].contains("mv"),
            "first command should be mkdir+mv, got: {}",
            commands[0]
        );

        // 2. git add
        assert!(
            commands[1].starts_with("git add"),
            "second command should be git add, got: {}",
            commands[1]
        );

        // Verify no commit or push commands were issued
        for cmd in commands.iter() {
            assert!(
                !cmd.starts_with("git commit"),
                "should not issue git commit when commit=false, but found: {}",
                cmd
            );
            assert!(
                !cmd.contains("git push"),
                "should not issue git push when commit=false, but found: {}",
                cmd
            );
        }
    }

    #[tokio::test]
    async fn test_move_plan_to_completed_move_failure() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![CommandOutput {
            exit_code: 1,
            stdout: String::new(),
            stderr: "No such file or directory".to_string(),
        }];

        let working_dir = std::path::PathBuf::from("/fake/repo");

        let result = move_plan_to_completed_impl(
            &runtime,
            &working_dir,
            "docs/plans",
            "nonexistent.md",
            true,
        )
        .await;

        assert!(result.is_err(), "should return error when mkdir+mv fails");
        let err = result.unwrap_err();
        assert!(
            err.contains("No such file or directory"),
            "error message should contain the stderr, got: {}",
            err
        );

        // Should have only attempted the first command (mkdir+mv) before bailing
        let commands = runtime.captured_commands.lock().unwrap();
        assert_eq!(
            commands.len(),
            1,
            "should only issue 1 command when mkdir+mv fails, got: {:?}",
            *commands
        );
    }
}
