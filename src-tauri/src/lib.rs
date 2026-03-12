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
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use oneshot::OneShotRunner;
use runtime::{default_runtime, ssh_command, ssh_command_raw, ssh_shell_escape, RuntimeProvider, SshEnvCache, SshRuntime};
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

#[derive(Debug, serde::Serialize, Clone)]
pub(crate) struct BranchInfo {
    name: String,
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
struct ActiveSessions {
    tokens: Mutex<HashMap<String, (CancellationToken, String)>>,
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
    max_iterations: u32,
    completion_signal: String,
    env_vars: Option<HashMap<String, String>>,
    checks: Option<Vec<session::Check>>,
    git_sync: Option<session::GitSyncConfig>,
    create_branch: bool,
) -> Result<trace::SessionTrace, String> {
    let cancel_token = CancellationToken::new();
    let session_id = Uuid::new_v4().to_string();
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.insert(repo_id.clone(), (cancel_token.clone(), session_id.clone()));
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);
            let runtime = default_runtime();

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = runtime.resolve_env().await;
            if let Some(warning) = runtime.env_warning() {
                let _ = app.emit("env-warning", &warning);
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
                        app.state::<ActiveSessions>()
                            .tokens
                            .lock()
                            .await
                            .remove(&repo_id);
                        return Err(format!(
                            "Failed to create branch '{}': {}",
                            branch_name, o.stderr
                        ));
                    }
                    Err(e) => {
                        app.state::<ActiveSessions>()
                            .tokens
                            .lock()
                            .await
                            .remove(&repo_id);
                        return Err(format!(
                            "Failed to create branch '{}': {}",
                            branch_name, e
                        ));
                    }
                    Ok(_) => {} // success, continue
                }
            }

            let prompt = prompt::build_prompt(&plan_path.to_string_lossy());

            let config = SessionConfig {
                repo_path: repo_path_buf,
                working_dir: None,
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync,
                iteration_offset: 0,
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
                }))
                .with_session_id(session_id);

            let result = runner.run(runtime.as_ref()).await.map_err(|e| e.to_string());
            app.state::<ActiveSessions>().tokens.lock().await.remove(&repo_id);
            result
        }
        RepoType::Ssh { ssh_host, remote_path } => {
            let ssh_runtime = SshRuntime::new(ssh_host, remote_path, app.state::<SshEnvCache>().cache_ref());

            // Pre-warm env cache and emit warning if snapshot failed
            let _ = ssh_runtime.resolve_env().await;
            if let Some(warning) = ssh_runtime.env_warning() {
                let _ = app.emit("env-warning", &warning);
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
            let prompt = prompt::build_prompt(&plan_path.to_string_lossy());

            let config = SessionConfig {
                repo_path: PathBuf::from(remote_path),
                working_dir: None,
                prompt,
                max_iterations,
                completion_signal,
                model: Some(model),
                extra_args: vec!["--dangerously-skip-permissions".to_string()],
                plan_file: Some(plan_file),
                inter_iteration_delay_ms: 1000,
                env_vars: env_vars.unwrap_or_default(),
                checks: checks.unwrap_or_default(),
                git_sync,
                iteration_offset: 0,
            };

            let base_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            let collector = TraceCollector::new(base_dir, &repo_id);

            let orchestrator = SshSessionOrchestrator::new(
                ssh_runtime,
                config,
                collector,
                cancel_token.clone(),
            )
            .with_trace_session_id(session_id);

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

#[derive(Debug, Clone, serde::Serialize)]
pub(crate) struct OneShotResult {
    pub oneshot_id: String,
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
    max_iterations: u32,
    completion_signal: String,
    checks: Option<Vec<session::Check>>,
    git_sync: Option<session::GitSyncConfig>,
) -> Result<OneShotResult, String> {
    let oneshot_id = oneshot::generate_oneshot_id();
    let cancel_token = CancellationToken::new();
    let session_id = Uuid::new_v4().to_string();
    {
        let active = app.state::<ActiveSessions>();
        active.tokens.lock().await.insert(oneshot_id.clone(), (cancel_token.clone(), session_id.clone()));
    }

    match &repo {
        RepoType::Local { path } => {
            let repo_path_buf = PathBuf::from(path);

            // Pre-warm env cache and emit warning if snapshot failed
            let runtime = default_runtime();
            let _ = runtime.resolve_env().await;
            if let Some(warning) = runtime.env_warning() {
                let _ = app.emit("env-warning", &warning);
            }

            let config = oneshot::OneShotConfig {
                repo_id: repo_id.clone(),
                repo_path: repo_path_buf,
                title,
                prompt,
                model,
                merge_strategy,
                env_vars: env_vars.unwrap_or_default(),
                max_iterations,
                completion_signal,
                checks: checks.unwrap_or_default(),
                git_sync,
            };

            let base_dir = match app.path().app_data_dir() {
                Ok(d) => d,
                Err(e) => {
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
                    let _ = app_handle.emit("session-event", TaggedSessionEvent {
                        repo_id: oneshot_id_clone.clone(),
                        event: event.clone(),
                    });
                }))
                .with_session_id(session_id);

            // Spawn as a background task so we return immediately
            let app_bg = app.clone();
            let oneshot_id_bg = oneshot_id.clone();
            tokio::spawn(async move {
                let runtime = default_runtime();
                let _result = runner.run(runtime.as_ref()).await;
                app_bg.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id_bg);
            });

            Ok(OneShotResult { oneshot_id })
        }
        RepoType::Ssh { .. } => {
            app.state::<ActiveSessions>().tokens.lock().await.remove(&oneshot_id);
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
async fn get_active_sessions(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let active = app.state::<ActiveSessions>();
    let pairs: Vec<(String, String)> = active.tokens.lock().await
        .iter()
        .map(|(repo_id, (_, session_id))| (repo_id.clone(), session_id.clone()))
        .collect();
    Ok(pairs)
}

#[tauri::command]
async fn stop_session(app: tauri::AppHandle, repo_id: String) -> Result<(), String> {
    let active = app.state::<ActiveSessions>();
    let tokens = active.tokens.lock().await;
    if let Some((token, _)) = tokens.get(&repo_id) {
        token.cancel();
        Ok(())
    } else {
        Err("No active session to stop".to_string())
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
    let remote_path = remote_path.trim().to_string();
    let steps = connection_test_steps(&ssh_host, &remote_path);
    for (step_name, mut cmd) in steps {
        let output = cmd.output().await.map_err(|e| e.to_string())?;
        if output.status.success() {
            let _ = app.emit("ssh-test-step", SshTestStep {
                step: step_name,
                status: "pass".to_string(),
                error: None,
            });
        } else {
            let error_msg = if step_name == "Remote path exists" {
                diagnose_path_failure(&ssh_host, &remote_path).await
            } else {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                if stderr.is_empty() { "Check failed".to_string() } else { stderr }
            };
            let _ = app.emit("ssh-test-step", SshTestStep {
                step: step_name,
                status: "fail".to_string(),
                error: Some(error_msg),
            });
            let _ = app.emit("ssh-test-complete", ());
            return Ok(());
        }
    }
    let _ = app.emit("ssh-test-complete", ());
    Ok(())
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
async fn get_branch_info(app: tauri::AppHandle, repo: RepoType) -> Result<BranchInfo, String> {
    let (rt, working_dir) = resolve_runtime(&repo, &app.state::<SshEnvCache>());
    let timeout = std::time::Duration::from_secs(30);

    let branch_output = rt
        .run_command("git branch --show-current", &working_dir, timeout)
        .await
        .map_err(|e| e.to_string())?;

    if branch_output.exit_code != 0 {
        return Err(branch_output.stderr);
    }

    let name = branch_output.stdout.trim().to_string();

    let rev_list_result = rt
        .run_command("git rev-list --left-right --count HEAD...@{upstream}", &working_dir, timeout)
        .await;

    let (ahead, behind) = match rev_list_result {
        Ok(output) if output.exit_code == 0 => parse_rev_list_output(&output.stdout),
        _ => (None, None),
    };

    Ok(BranchInfo { name, ahead, behind })
}

#[tauri::command]
async fn list_local_branches(app: tauri::AppHandle, repo: RepoType) -> Result<Vec<String>, String> {
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

    Ok(branches)
}

#[tauri::command]
async fn switch_branch(app: tauri::AppHandle, repo: RepoType, branch: String) -> Result<(), String> {
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

    Ok(())
}

#[tauri::command]
async fn fast_forward_branch(app: tauri::AppHandle, repo: RepoType) -> Result<(), String> {
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
    move_plan_to_completed_impl(rt.as_ref(), &working_dir, &plans_dir, &filename).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let log_level = std::env::var("RUST_LOG")
        .ok()
        .and_then(|s| s.parse::<log::LevelFilter>().ok())
        .unwrap_or(log::LevelFilter::Info);

    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![run_session, run_oneshot, stop_session, get_active_sessions, test_ssh_connection_steps, reconnect_session, list_traces, list_latest_traces, get_trace, get_trace_events, read_file_preview, get_branch_info, list_local_branches, switch_branch, fast_forward_branch, list_plans, move_plan_to_completed])
        .build(tauri::generate_context!())
        .expect("error building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                // Cancel all cancellation tokens
                let active = app.state::<ActiveSessions>();
                if let Ok(guard) = active.tokens.try_lock() {
                    for (repo_id, (token, _)) in guard.iter() {
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
            merge_strategy: MergeStrategy::MergeToMain,
            env_vars: env,
            max_iterations: 20,
            completion_signal: "<promise>COMPLETE</promise>".to_string(),
            checks: vec![],
            git_sync: None,
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

    // --- BranchInfo serialization tests ---

    #[test]
    fn branch_info_serializes_with_all_fields() {
        let info = BranchInfo {
            name: "feature/login".to_string(),
            ahead: Some(3),
            behind: Some(5),
        };

        let json = serde_json::to_value(&info).expect("serialization should succeed");

        assert_eq!(json["name"], "feature/login");
        assert_eq!(json["ahead"], 3);
        assert_eq!(json["behind"], 5);
    }

    #[test]
    fn branch_info_serializes_with_none_ahead_behind() {
        let info = BranchInfo {
            name: "main".to_string(),
            ahead: None,
            behind: None,
        };

        let json = serde_json::to_value(&info).expect("serialization should succeed");

        assert_eq!(json["name"], "main");
        assert!(json["ahead"].is_null(), "ahead should serialize as null");
        assert!(json["behind"].is_null(), "behind should serialize as null");
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
        move_plan_to_completed_impl(rt.as_ref(), dir.path(), "plans", "my-plan.md")
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
        let result = move_plan_to_completed_impl(rt.as_ref(), dir.path(), "plans", "nonexistent.md")
            .await;

        assert!(result.is_err(),
            "should return Err when source file does not exist");
    }

    // --- OneShotResult tests ---

    #[test]
    fn oneshot_result_serializes_with_oneshot_id() {
        let result = OneShotResult {
            oneshot_id: "oneshot-a1b2c3".to_string(),
        };

        let json = serde_json::to_value(&result).expect("serialization should succeed");

        assert!(json.get("oneshot_id").is_some(), "JSON should contain 'oneshot_id' field");
        assert_eq!(json["oneshot_id"], "oneshot-a1b2c3");
    }

    #[test]
    fn oneshot_result_clone_produces_equal_json() {
        let result = OneShotResult {
            oneshot_id: "oneshot-d4e5f6".to_string(),
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
    }
}
