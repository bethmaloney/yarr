use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;
use tracing::instrument;

use super::{shell_env, AbortHandle, ClaudeInvocation, CommandOutput, ProcessExit, RunningProcess, RuntimeProvider, TaskAbortHandle};
use crate::output::StreamEvent;

/// State of a remote SSH session, determined by checking tmux and log file.
#[derive(Debug, Clone, PartialEq)]
pub enum RemoteState {
    /// Tmux session is alive, claude is still running
    Alive,
    /// Tmux session is dead, log contains a Result event (completed normally)
    CompletedOk,
    /// Tmux session is dead, no Result event found (crashed or killed)
    Dead,
}

/// Shell-escapes a string by wrapping in single quotes and escaping embedded single quotes.
pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Builds an SSH command for executing a remote command on the given host.
///
/// - On Linux/macOS: `ssh <options> <host> $SHELL -lc '<remote_cmd>'`
/// - On Windows: `wsl -e bash -lc "ssh <options> <host> \$SHELL -lc '<remote_cmd>'"`
///
/// SSH options include `-o BatchMode=yes -o StrictHostKeyChecking=accept-new`
/// for non-interactive use.
///
/// Remote commands are wrapped in `$SHELL -lc` to ensure the remote user's
/// login shell sources its startup files (`.zshrc`, `.bash_profile`, etc.).
/// This is necessary because non-interactive SSH commands don't source login
/// profiles, so binaries installed in user-specific PATH directories (like
/// `~/.local/bin`) wouldn't be found otherwise.
///
/// The caller is responsible for properly escaping `remote_cmd` contents
/// (e.g. using `shell_escape()` for individual arguments within the command).
pub fn ssh_command(host: &str, remote_cmd: &str) -> Command {
    if cfg!(target_os = "windows") {
        // Double-escape: inner shell_escape quotes for the remote shell (so $SHELL -lc
        // receives the full command as one argument), outer shell_escape quotes for WSL bash.
        let ssh_str = format!(
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} \\$SHELL -lc {}",
            shell_escape(host),
            shell_escape(&shell_escape(remote_cmd))
        );
        let mut cmd = Command::new("wsl");
        cmd.arg("-e").arg("bash").arg("-lc").arg(ssh_str);
        cmd
    } else {
        let mut cmd = Command::new("ssh");
        cmd.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg(host)
            .arg(format!("$SHELL -lc {}", shell_escape(remote_cmd)));
        cmd
    }
}

/// Builds an SSH command for executing a remote command **without** the
/// `$SHELL -lc` login shell wrapper.
///
/// Use this for commands that only need builtins or standard `/usr/bin`
/// utilities (e.g. `test -d`, `echo`, `stat`) and don't depend on the
/// remote user's custom PATH from their login shell startup files.
pub fn ssh_command_raw(host: &str, remote_cmd: &str) -> Command {
    if cfg!(target_os = "windows") {
        let ssh_str = format!(
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
            shell_escape(host),
            shell_escape(remote_cmd)
        );
        let mut cmd = Command::new("wsl");
        cmd.arg("-e").arg("bash").arg("-lc").arg(ssh_str);
        cmd
    } else {
        let mut cmd = Command::new("ssh");
        cmd.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg(host)
            .arg(remote_cmd);
        cmd
    }
}

fn env_export_parts(env: &HashMap<String, String>) -> Vec<String> {
    env.iter()
        .map(|(key, val)| format!("export {}={}", key, shell_escape(val)))
        .collect()
}

pub struct SshRuntime {
    pub ssh_host: String,
    pub remote_path: String,
    pub(crate) env_cache: Arc<dashmap::DashMap<String, HashMap<String, String>>>,
    env_warning: Arc<std::sync::Mutex<Option<String>>>,
}

/// Abort handle that kills the remote tmux session before aborting the task.
struct SshAbortHandle {
    task_handle: tokio::task::AbortHandle,
    ssh_host: String,
    session_id: String,
}

impl AbortHandle for SshAbortHandle {
    fn abort(&self) {
        // Abort the tokio task immediately — don't wait for SSH/WSL kill commands
        self.task_handle.abort();

        // Fire-and-forget the kill commands in a background thread so they
        // can't block the runtime if WSL/SSH is unresponsive.
        let ssh_host = self.ssh_host.clone();
        let session_id = self.session_id.clone();
        std::thread::spawn(move || {
            let kill_cmd = format!("tmux kill-session -t yarr-{}", session_id);
            tracing::info!("Killing remote tmux session yarr-{}", session_id);
            if cfg!(target_os = "windows") {
                let ssh_str = format!(
                    "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} \\$SHELL -lc {}",
                    shell_escape(&ssh_host),
                    shell_escape(&kill_cmd)
                );
                let _ = std::process::Command::new("wsl")
                    .args(["-e", "bash", "-lc", &ssh_str])
                    .output();
            } else {
                let _ = std::process::Command::new("ssh")
                    .arg("-o")
                    .arg("BatchMode=yes")
                    .arg("-o")
                    .arg("StrictHostKeyChecking=accept-new")
                    .arg(&ssh_host)
                    .arg(format!("$SHELL -lc {}", shell_escape(&kill_cmd)))
                    .output();
            }
        });
    }
}

impl SshRuntime {
    pub fn new(host: &str, remote_path: &str, env_cache: Arc<dashmap::DashMap<String, HashMap<String, String>>>) -> Self {
        Self {
            ssh_host: host.to_string(),
            remote_path: remote_path.to_string(),
            env_cache,
            env_warning: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    pub fn build_mkdir_command(&self) -> Command {
        ssh_command(&self.ssh_host, "mkdir -p ~/.yarr/logs")
    }

    pub fn build_tmux_command(&self, session_id: &str, invocation: &ClaudeInvocation, resolved_env: &HashMap<String, String>) -> Command {
        let escaped_prompt = shell_escape(&invocation.prompt);
        let escaped_remote_path = shell_escape(&self.remote_path);

        let mut claude_cmd = String::from("claude -p --output-format stream-json --verbose");

        if let Some(ref model) = invocation.model {
            claude_cmd.push_str(&format!(" --model {}", shell_escape(model)));
        }

        if let Some(ref effort) = invocation.effort_level {
            claude_cmd.push_str(&format!(" --effort {}", shell_escape(effort)));
        }

        for arg in &invocation.extra_args {
            claude_cmd.push_str(&format!(" {}", shell_escape(arg)));
        }

        claude_cmd.push_str(&format!(" {}", escaped_prompt));

        // Build the inner command that runs inside tmux (executed by sh -c).
        let mut env_exports = String::new();
        for (key, val) in &invocation.env_vars {
            env_exports.push_str(&format!("export {}={} && ", key, shell_escape(val)));
        }

        let tmux_body = format!(
            "cd {escaped_remote_path} && {env_exports}{claude_cmd} 2>/tmp/yarr-{session_id}.stderr | tee ~/.yarr/logs/yarr-{session_id}.log"
        );

        // Build the outer command: env exports + tmux new-session
        let mut parts: Vec<String> = Vec::new();
        parts.extend(env_export_parts(resolved_env));
        parts.push(format!(
            "tmux new-session -d -s yarr-{session_id} {}",
            shell_escape(&tmux_body)
        ));

        let remote_cmd = parts.join(" && ");
        ssh_command_raw(&self.ssh_host, &remote_cmd)
    }

    pub fn build_tail_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!("tail -f ~/.yarr/logs/yarr-{session_id}.log");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_health_check_command(&self, resolved_env: &HashMap<String, String>) -> Command {
        let mut parts: Vec<String> = Vec::new();
        parts.extend(env_export_parts(resolved_env));
        parts.push("command -v tmux && command -v claude && echo OK".to_string());
        let remote_cmd = parts.join(" && ");
        ssh_command_raw(&self.ssh_host, &remote_cmd)
    }

    pub fn build_check_tmux_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!(
            "tmux has-session -t yarr-{session_id} 2>/dev/null && echo ALIVE || echo DEAD"
        );
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_tail_last_line_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!("tail -1 ~/.yarr/logs/yarr-{session_id}.log");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_recover_command(&self, session_id: &str, from_line: u64) -> Command {
        let remote_cmd = format!("tail -n +{from_line} ~/.yarr/logs/yarr-{session_id}.log");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_resume_tail_command(&self, session_id: &str, from_line: u64) -> Command {
        let remote_cmd = format!("tail -f -n +{from_line} ~/.yarr/logs/yarr-{session_id}.log");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_cleanup_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!(
            "rm -f ~/.yarr/logs/yarr-{session_id}.log /tmp/yarr-{session_id}.stderr"
        );
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_get_stderr_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!("cat /tmp/yarr-{session_id}.stderr 2>/dev/null");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_run_command(&self, command: &str, working_dir: &std::path::Path, resolved_env: &HashMap<String, String>) -> Command {
        let escaped_dir = shell_escape(&working_dir.to_string_lossy());
        let mut parts: Vec<String> = Vec::new();
        parts.extend(env_export_parts(resolved_env));
        parts.push(format!("cd {}", escaped_dir));
        parts.push(command.to_string());
        let remote_cmd = parts.join(" && ");
        ssh_command_raw(&self.ssh_host, &remote_cmd)
    }

    /// Parse the combined output of tmux check and last log line into a RemoteState.
    pub fn parse_remote_state(tmux_output: &str, last_log_line: &str) -> RemoteState {
        if tmux_output.trim().contains("ALIVE") {
            return RemoteState::Alive;
        }
        // Tmux is dead — check if the log has a Result event
        let trimmed = last_log_line.trim();
        if !trimmed.is_empty() {
            if let Ok(StreamEvent::Result(_)) = StreamEvent::parse_line(trimmed) {
                return RemoteState::CompletedOk;
            }
        }
        RemoteState::Dead
    }

    /// Check if a remote session is still running.
    pub async fn check_remote_state(&self, session_id: &str) -> Result<RemoteState> {
        let tmux_output = self.build_check_tmux_command(session_id).output().await?;
        let tmux_stdout = String::from_utf8_lossy(&tmux_output.stdout).to_string();

        let last_line_output = self.build_tail_last_line_command(session_id).output().await?;
        let last_line = String::from_utf8_lossy(&last_line_output.stdout).to_string();

        Ok(Self::parse_remote_state(&tmux_stdout, &last_line))
    }

    /// Recover missed events from the log file starting at the given line.
    #[instrument(skip(self), fields(ssh_host = %self.ssh_host, session_id = %session_id, from_line = from_line))]
    pub async fn recover_events(
        &self,
        session_id: &str,
        from_line: u64,
    ) -> Result<Vec<StreamEvent>> {
        let output = self
            .build_recover_command(session_id, from_line)
            .output()
            .await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to recover events: {}", stderr);
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line_count = stdout.lines().filter(|l| !l.trim().is_empty()).count();
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, from_line = from_line, recovered_lines = line_count, "recovered log lines from remote");
        let events = parse_log_lines(&stdout);
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, event_count = events.len(), "parsed events from recovered log lines");
        Ok(events)
    }

    /// Resume tailing the log file from the given line, returning a RunningProcess.
    pub async fn resume_tail(
        &self,
        session_id: &str,
        from_line: u64,
    ) -> Result<RunningProcess> {
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, from_line = from_line, "initiating resume tail of remote log file");
        let start = std::time::Instant::now();
        let mut child = self
            .build_resume_tail_command(session_id, from_line)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout was piped");
        let (tx, rx) = mpsc::channel::<StreamEvent>(64);

        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                match StreamEvent::parse_line(&line) {
                    Ok(event) => {
                        if tx.send(event).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse stream-json line: {e}\n  line: {line}");
                    }
                }
            }
        });

        let completion = tokio::spawn(async move {
            let status = child.wait().await?;
            let _ = reader_task.await;
            let elapsed = start.elapsed();
            Ok(ProcessExit {
                exit_code: status.code().unwrap_or(-1),
                wall_time_ms: elapsed.as_millis() as u64,
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

    /// Clean up remote log and stderr files.
    pub async fn cleanup_remote(&self, session_id: &str) -> Result<()> {
        tracing::info!(ssh_host = %self.ssh_host, session_id = %session_id, "cleaning up remote log and stderr files");
        let output = self.build_cleanup_command(session_id).output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to clean up remote files: {}", stderr);
        }
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, "remote cleanup completed");
        Ok(())
    }

    /// Retrieve stderr output from the remote.
    pub async fn get_stderr(&self, session_id: &str) -> Result<String> {
        let output = self.build_get_stderr_command(session_id).output().await?;
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for SshRuntime {
    fn name(&self) -> &str {
        "ssh"
    }

    #[instrument(skip(self, invocation), fields(ssh_host = %self.ssh_host, model = ?invocation.model))]
    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        tracing::info!(
            ssh_host = %self.ssh_host,
            remote_path = %self.remote_path,
            model = ?invocation.model,
            "ssh spawn_claude starting"
        );
        let env = self.resolve_env().await?;
        let start = std::time::Instant::now();
        let session_id = uuid::Uuid::new_v4().to_string();
        tracing::info!(ssh_host = %self.ssh_host, session_id = %session_id, "setting up remote log directory");

        // Create log directory and touch the log file so tail -f doesn't race
        let setup_cmd = format!(
            "mkdir -p ~/.yarr/logs && touch ~/.yarr/logs/yarr-{session_id}.log"
        );
        let setup_output = ssh_command(&self.ssh_host, &setup_cmd).output().await?;
        if !setup_output.status.success() {
            let stderr = String::from_utf8_lossy(&setup_output.stderr);
            tracing::error!(ssh_host = %self.ssh_host, stderr = %stderr, "failed to set up remote log directory");
            anyhow::bail!("Failed to set up remote log directory: {}", stderr);
        }

        // Start tmux session with resolved env
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, "building tmux command for remote session");
        tracing::info!(ssh_host = %self.ssh_host, session_id = %session_id, "starting remote tmux session");
        let tmux_output = self
            .build_tmux_command(&session_id, invocation, &env)
            .output()
            .await?;
        if !tmux_output.status.success() {
            let stderr = String::from_utf8_lossy(&tmux_output.stderr);
            tracing::error!(ssh_host = %self.ssh_host, session_id = %session_id, stderr = %stderr, "failed to start remote tmux session");
            anyhow::bail!("Failed to start remote tmux session: {}", stderr);
        }
        tracing::info!(ssh_host = %self.ssh_host, session_id = %session_id, "remote tmux session started, tailing log");

        // Tail the log file
        tracing::debug!(ssh_host = %self.ssh_host, session_id = %session_id, "setting up tail command for log file");
        let mut child = self
            .build_tail_command(&session_id)
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let stdout = child.stdout.take().expect("stdout was piped");

        let (tx, rx) = mpsc::channel::<StreamEvent>(64);

        let reader_task = tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }
                match StreamEvent::parse_line(&line) {
                    Ok(event) => {
                        if tx.send(event).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse stream-json line: {e}\n  line: {line}");
                    }
                }
            }
        });

        let completion = tokio::spawn(async move {
            let status = child.wait().await?;
            let _ = reader_task.await;
            let elapsed = start.elapsed();
            Ok(ProcessExit {
                exit_code: status.code().unwrap_or(-1),
                wall_time_ms: elapsed.as_millis() as u64,
                stderr: String::new(),
            })
        });

        let abort_handle = SshAbortHandle {
            task_handle: completion.abort_handle(),
            ssh_host: self.ssh_host.clone(),
            session_id: session_id.clone(),
        };
        tracing::info!(ssh_host = %self.ssh_host, session_id = %session_id, "ssh spawn_claude completed successfully");
        Ok(RunningProcess {
            events: rx,
            completion,
            abort_handle: Box::new(abort_handle),
        })
    }

    #[instrument(skip(self), fields(ssh_host = %self.ssh_host))]
    async fn health_check(&self) -> Result<()> {
        tracing::debug!(ssh_host = %self.ssh_host, "ssh health check starting");
        let env = self.resolve_env().await?;
        let output = self.build_health_check_command(&env).output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.contains("OK") {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let reason = if stderr.trim().is_empty() {
                "tmux or claude not found".to_string()
            } else {
                stderr.trim().to_string()
            };
            tracing::error!(ssh_host = %self.ssh_host, reason = %reason, "ssh health check failed");
            anyhow::bail!("SSH health check failed on {}: {}", self.ssh_host, reason);
        }
        tracing::debug!(ssh_host = %self.ssh_host, "ssh health check passed");
        Ok(())
    }

    #[instrument(skip(self, command, working_dir), fields(ssh_host = %self.ssh_host, timeout_secs = timeout.as_secs()))]
    async fn run_command(
        &self,
        command: &str,
        working_dir: &std::path::Path,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput> {
        tracing::debug!(ssh_host = %self.ssh_host, command = %command, working_dir = %working_dir.display(), timeout_secs = timeout.as_secs(), "ssh run_command");
        let env = self.resolve_env().await?;
        let child = self
            .build_run_command(command, working_dir, &env)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
        match result {
            Ok(Ok(output)) => Ok(CommandOutput {
                exit_code: output.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            }),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => {
                // child is dropped here, kill_on_drop(true) ensures cleanup
                tracing::warn!(ssh_host = %self.ssh_host, command = %command, timeout_secs = timeout.as_secs(), "ssh command timed out");
                anyhow::bail!("Command timed out after {:?}", timeout)
            }
        }
    }

    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        // Check cache first
        if let Some(cached) = self.env_cache.get(&self.ssh_host) {
            return Ok(cached.clone());
        }

        // Snapshot via SSH
        let host = self.ssh_host.clone();
        match shell_env::snapshot_shell_env(
            |cmd| {
                let host = host.clone();
                async move {
                    let output = ssh_command_raw(&host, &cmd).output().await?;
                    Ok(output)
                }
            },
            shell_env::SSH_TIMEOUT,
            shell_env::SSH_DENYLIST,
        )
        .await
        {
            Ok(env) => {
                self.env_cache.insert(self.ssh_host.clone(), env.clone());
                Ok(env)
            }
            Err(e) => {
                let warning = format!(
                    "Failed to load shell environment for {} — some tools (nvm, pyenv, etc.) may not be available. Restart the app to retry. Error: {e}",
                    self.ssh_host
                );
                tracing::warn!("{warning}");
                *self.env_warning.lock().unwrap() = Some(warning);
                Ok(HashMap::new())
            }
        }
    }

    fn env_warning(&self) -> Option<String> {
        self.env_warning.lock().unwrap().clone()
    }
}

/// Parse multiple lines of stream-json log output into events.
/// Skips empty lines and warns on lines that fail to parse.
pub(crate) fn parse_log_lines(input: &str) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for line in input.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match StreamEvent::parse_line(line) {
            Ok(event) => events.push(event),
            Err(e) => tracing::warn!("Failed to parse recovered event: {e}\n  line: {line}"),
        }
    }
    events
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn test_cache() -> std::sync::Arc<dashmap::DashMap<String, HashMap<String, String>>> {
        std::sync::Arc::new(dashmap::DashMap::new())
    }

    // ── shell_escape tests ──────────────────────────────────────────

    #[test]
    fn shell_escape_simple_string() {
        assert_eq!(shell_escape("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_string_with_spaces() {
        assert_eq!(shell_escape("hello world"), "'hello world'");
    }

    #[test]
    fn shell_escape_string_with_single_quotes() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_string_with_double_quotes() {
        assert_eq!(shell_escape(r#"say "hi""#), r#"'say "hi"'"#);
    }

    #[test]
    fn shell_escape_string_with_special_shell_chars() {
        assert_eq!(shell_escape("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn shell_escape_empty_string() {
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn shell_escape_string_with_backslashes() {
        assert_eq!(shell_escape(r"a\b"), r"'a\b'");
    }

    // ── ssh_command tests ───────────────────────────────────────────

    #[test]
    fn ssh_command_creates_command_with_ssh_program() {
        let cmd = ssh_command("myhost", "ls");
        let std_cmd = cmd.as_std();

        if cfg!(target_os = "windows") {
            assert_eq!(
                std_cmd.get_program(),
                "wsl",
                "on Windows the outer program should be wsl"
            );
        } else {
            assert_eq!(
                std_cmd.get_program(),
                "ssh",
                "on Linux/macOS the program should be ssh"
            );
        }
    }

    #[test]
    fn ssh_command_includes_host_in_args() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("myhost")),
            "expected 'myhost' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_remote_command_in_args() {
        let cmd = ssh_command("myhost", "ls -la");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("ls -la")),
            "expected 'ls -la' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_batch_mode_option() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            all_args.contains("BatchMode=yes"),
            "expected 'BatchMode=yes' in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_strict_host_key_checking_option() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            all_args.contains("StrictHostKeyChecking=accept-new"),
            "expected 'StrictHostKeyChecking=accept-new' in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_with_user_at_host() {
        let cmd = ssh_command("beth@server", "whoami");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected 'beth@server' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_remote_cmd_with_spaces() {
        let cmd = ssh_command("host", "cat /etc/hostname");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("cat /etc/hostname")),
            "expected 'cat /etc/hostname' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_on_unix_does_not_use_wsl() {
        let cmd = ssh_command("myhost", "ls");
        let std_cmd = cmd.as_std();

        assert_eq!(
            std_cmd.get_program(),
            "ssh",
            "on Unix the program should be ssh, not wsl"
        );

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            !args_str.iter().any(|a| *a == "wsl"),
            "on Unix, 'wsl' should not appear in args: {:?}",
            args_str
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_wraps_in_login_shell() {
        let cmd = ssh_command("myhost", "ls -la");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let last_arg = args_str.last().expect("should have args");

        assert!(
            last_arg.starts_with("$SHELL -lc "),
            "expected last arg to start with '$SHELL -lc ', got: {}",
            last_arg
        );
        assert!(
            last_arg.contains("ls -la"),
            "expected original command in login shell wrapper, got: {}",
            last_arg
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_login_shell_escapes_single_quotes() {
        let cmd = ssh_command("myhost", "echo 'hello'");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let last_arg = args_str.last().expect("should have args");

        // The remote_cmd contains single quotes, which shell_escape wraps
        // in the pattern: 'echo '\''hello'\'''
        assert!(
            last_arg.starts_with("$SHELL -lc "),
            "expected login shell wrapper, got: {}",
            last_arg
        );
        assert!(
            last_arg.contains("'\\''"),
            "expected escaped single quotes in login shell wrapper, got: {}",
            last_arg
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_login_shell_preserves_dollar_sign() {
        let cmd = ssh_command("myhost", "echo test");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let last_arg = args_str.last().expect("should have args");

        // On Unix, $SHELL should appear literally in the arg (not expanded)
        assert!(
            last_arg.contains("$SHELL"),
            "expected literal '$SHELL' in arg (not expanded), got: {}",
            last_arg
        );
    }

    // ── ssh_command_raw tests ────────────────────────────────────

    #[test]
    fn ssh_command_raw_creates_command_with_ssh_program() {
        let cmd = ssh_command_raw("myhost", "echo hello");
        let std_cmd = cmd.as_std();

        if cfg!(target_os = "windows") {
            assert_eq!(
                std_cmd.get_program(),
                "wsl",
                "on Windows the outer program should be wsl"
            );
        } else {
            assert_eq!(
                std_cmd.get_program(),
                "ssh",
                "on Linux/macOS the program should be ssh"
            );
        }
    }

    #[test]
    fn ssh_command_raw_includes_host_in_args() {
        let cmd = ssh_command_raw("myhost", "echo hello");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("myhost")),
            "expected 'myhost' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_raw_includes_remote_command_in_args() {
        let cmd = ssh_command_raw("myhost", "test -d /tmp");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("test -d /tmp")),
            "expected 'test -d /tmp' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_raw_does_not_wrap_in_login_shell() {
        let cmd = ssh_command_raw("myhost", "echo hello");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            !args_str.iter().any(|a| a.contains("$SHELL -lc")),
            "expected no '$SHELL -lc' in args for ssh_command_raw, got: {:?}",
            args_str
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_raw_includes_batch_mode() {
        let cmd = ssh_command_raw("myhost", "echo hello");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a == &"BatchMode=yes"),
            "expected 'BatchMode=yes' in args, got: {:?}",
            args_str
        );
    }

    // ── SshRuntime construction tests ────────────────────────────

    use crate::runtime::{ClaudeInvocation, RuntimeProvider};
    use std::path::PathBuf;

    #[test]
    fn ssh_runtime_new_stores_host() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project", test_cache());
        assert_eq!(rt.ssh_host, "devbox.example.com");
    }

    #[test]
    fn ssh_runtime_new_stores_remote_path() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project", test_cache());
        assert_eq!(rt.remote_path, "/home/user/project");
    }

    #[test]
    fn ssh_runtime_name_returns_ssh() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project", test_cache());
        assert_eq!(rt.name(), "ssh");
    }

    #[test]
    fn ssh_runtime_new_with_user_at_host() {
        let rt = SshRuntime::new("beth@devbox.example.com", "/home/beth/repos", test_cache());
        assert_eq!(rt.ssh_host, "beth@devbox.example.com");
    }

    #[test]
    fn ssh_runtime_new_with_ip_address() {
        let rt = SshRuntime::new("192.168.1.100", "/opt/project", test_cache());
        assert_eq!(rt.ssh_host, "192.168.1.100");
    }

    // ── SshRuntime command building tests ────────────────────────

    #[test]
    fn build_mkdir_command_creates_log_directory() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_mkdir_command();
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("mkdir -p ~/.yarr/logs"),
            "expected mkdir command for log directory, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_mkdir_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_mkdir_command();
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_tmux_command_contains_session_name() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command(session_id, &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("yarr-abc-123"),
            "expected tmux session name 'yarr-abc-123' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_uses_tmux_new_session_detached() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tmux new-session -d -s"),
            "expected 'tmux new-session -d -s' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_includes_cd_to_remote_path() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The remote_path is shell_escape'd for the inner (tmux) shell layer,
        // and then the entire tmux body is shell_escape'd for the outer (SSH)
        // shell layer, so the cd and path are separated by escape sequences.
        assert!(
            all_args.contains("cd") && all_args.contains("/home/user/project"),
            "expected 'cd' and '/home/user/project' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_includes_claude_with_stream_json() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "do something".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("claude -p"),
            "expected 'claude -p' in command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("--output-format stream-json"),
            "expected '--output-format stream-json' in command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("--verbose"),
            "expected '--verbose' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_includes_stderr_redirect() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command(session_id, &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("2>/tmp/yarr-abc-123.stderr"),
            "expected stderr redirect to /tmp/yarr-abc-123.stderr, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_pipes_to_tee_with_log_path() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command(session_id, &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tee ~/.yarr/logs/yarr-abc-123.log"),
            "expected tee to log file, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_includes_model_when_specified() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: Some("claude-sonnet-4-20250514".to_string()),
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("--model") && all_args.contains("claude-sonnet-4-20250514"),
            "expected '--model claude-sonnet-4-20250514' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_excludes_model_when_none() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            !all_args.contains("--model"),
            "expected no '--model' flag when model is None, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_includes_extra_args() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![
                "--max-turns".to_string(),
                "5".to_string(),
            ],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("--max-turns"),
            "expected '--max-turns' in command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("5"),
            "expected '5' in command args, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_embeds_prompt_in_command() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug in main.rs".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The prompt should be embedded in the SSH command (not piped via stdin)
        assert!(
            all_args.contains("Fix the bug in main.rs"),
            "expected prompt text embedded in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tail_command_follows_correct_log_file() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "abc-123";
        let cmd = rt.build_tail_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -f ~/.yarr/logs/yarr-abc-123.log"),
            "expected 'tail -f' of log file, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tail_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_tail_command("sess-1");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in tail command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_health_check_command_checks_tmux_and_claude() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_health_check_command(&HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("command -v tmux"),
            "expected 'command -v tmux' in health check, got: {}",
            all_args
        );
        assert!(
            all_args.contains("command -v claude"),
            "expected 'command -v claude' in health check, got: {}",
            all_args
        );
        assert!(
            all_args.contains("echo OK"),
            "expected 'echo OK' in health check, got: {}",
            all_args
        );
    }

    #[test]
    fn build_health_check_command_targets_correct_host() {
        let rt = SshRuntime::new("user@10.0.0.1", "/opt/repos/app", test_cache());
        let cmd = rt.build_health_check_command(&HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("user@10.0.0.1")),
            "expected host 'user@10.0.0.1' in health check args, got: {:?}",
            args_str
        );
    }

    // ── Edge cases: remote path with spaces ──────────────────────

    #[test]
    fn build_tmux_command_escapes_remote_path_with_spaces() {
        let rt = SshRuntime::new("devbox", "/home/user/my project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/my project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The path with spaces must be properly escaped so it doesn't break
        // the remote shell command. It should appear in some quoted/escaped form.
        assert!(
            all_args.contains("my project"),
            "expected remote path with spaces in command, got: {}",
            all_args
        );
    }

    // ── Edge cases: prompt escaping ──────────────────────────────

    #[test]
    fn build_tmux_command_escapes_prompt_with_single_quotes() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug in it's parser".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // The single quote in the prompt must be escaped for the remote shell
        assert!(
            all_args.contains("it") && all_args.contains("parser"),
            "expected prompt content (with escaped quotes) in command, got: {}",
            all_args
        );
        // Verify it uses shell_escape pattern (escaped single quote)
        assert!(
            all_args.contains("'\\''"),
            "expected shell-escaped single quote in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_escapes_prompt_with_double_quotes() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: r#"Fix the "broken" function"#.to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(r#""broken""#),
            "expected double quotes preserved in prompt, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_escapes_prompt_with_shell_metacharacters() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "Run $(whoami) && echo $HOME | cat".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // Shell metacharacters should be inside single quotes (via shell_escape)
        // so they are treated literally, not executed by the remote shell
        assert!(
            all_args.contains("$(whoami)"),
            "expected shell metacharacters preserved in prompt, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_handles_empty_prompt() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        // Should not panic; the command should still be constructable
        assert!(
            !args.is_empty(),
            "expected non-empty args even with empty prompt"
        );
    }

    // ── Edge cases: session ID in paths ──────────────────────────

    #[test]
    fn build_tmux_command_session_id_appears_in_tmux_name_and_log_and_stderr() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command(session_id, &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        let expected_name = format!("yarr-{}", session_id);
        let expected_log = format!("yarr-{}.log", session_id);
        let expected_stderr = format!("yarr-{}.stderr", session_id);

        assert!(
            all_args.contains(&expected_name),
            "expected tmux session name '{}' in command, got: {}",
            expected_name, all_args
        );
        assert!(
            all_args.contains(&expected_log),
            "expected log filename '{}' in command, got: {}",
            expected_log, all_args
        );
        assert!(
            all_args.contains(&expected_stderr),
            "expected stderr filename '{}' in command, got: {}",
            expected_stderr, all_args
        );
    }

    #[test]
    fn build_tail_command_session_id_in_log_path() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "my-session-42";
        let cmd = rt.build_tail_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}.log", session_id)),
            "expected session ID in tail log path, got: {}",
            all_args
        );
    }

    // ── Edge cases: model and extra args together ────────────────

    #[test]
    fn build_tmux_command_with_model_and_extra_args() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: Some("claude-opus-4-6".to_string()),
            effort_level: None,
            extra_args: vec![
                "--allowedTools".to_string(),
                "Bash,Read,Write".to_string(),
            ],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("--model") && all_args.contains("claude-opus-4-6"),
            "expected model flag in command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("--allowedTools"),
            "expected extra args in command, got: {}",
            all_args
        );
    }

    // ── Command targets correct host ─────────────────────────────

    #[test]
    fn build_tmux_command_targets_correct_host() {
        let rt = SshRuntime::new("deploy@prod-server.internal", "/srv/app", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/srv/app"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("deploy@prod-server.internal")),
            "expected host 'deploy@prod-server.internal' in args, got: {:?}",
            args_str
        );
    }

    // ── SSH command uses BatchMode ───────────────────────────────

    #[test]
    fn build_tmux_command_uses_ssh_with_batch_mode() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("BatchMode=yes"),
            "expected SSH BatchMode=yes option, got: {}",
            all_args
        );
    }

    #[test]
    fn build_health_check_command_uses_ssh_with_batch_mode() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_health_check_command(&HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("BatchMode=yes"),
            "expected SSH BatchMode=yes option in health check, got: {}",
            all_args
        );
    }

    // ── Multiline / complex prompts ──────────────────────────────

    #[test]
    fn build_tmux_command_handles_multiline_prompt() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug.\nThen run the tests.\nReport results.".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        // Should not panic with multiline prompt
        assert!(
            !args.is_empty(),
            "expected non-empty args with multiline prompt"
        );

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("Fix the bug"),
            "expected prompt content in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_handles_prompt_with_backticks() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "Explain what `main()` does".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // Backticks inside single quotes are literal, not command substitution
        assert!(
            all_args.contains("`main()`"),
            "expected backtick-wrapped text preserved in prompt, got: {}",
            all_args
        );
    }

    // ── build_check_tmux_command tests ────────────────────────────

    #[test]
    fn build_check_tmux_command_contains_tmux_has_session() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_check_tmux_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tmux has-session -t yarr-abc-123"),
            "expected 'tmux has-session -t yarr-abc-123' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_check_tmux_command_echoes_alive_or_dead() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_check_tmux_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("echo ALIVE"),
            "expected 'echo ALIVE' in command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("echo DEAD"),
            "expected 'echo DEAD' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_check_tmux_command_suppresses_stderr() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_check_tmux_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("2>/dev/null"),
            "expected stderr suppression '2>/dev/null' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_check_tmux_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_check_tmux_command("sess-1");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in check tmux command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_check_tmux_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let cmd = rt.build_check_tmux_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}", session_id)),
            "expected session id in tmux session name, got: {}",
            all_args
        );
    }

    // ── build_tail_last_line_command tests ─────────────────────────

    #[test]
    fn build_tail_last_line_command_tails_one_line() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_tail_last_line_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -1 ~/.yarr/logs/yarr-abc-123.log"),
            "expected 'tail -1' of log file, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tail_last_line_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_tail_last_line_command("sess-1");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in tail last line command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_tail_last_line_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "my-session-42";
        let cmd = rt.build_tail_last_line_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}.log", session_id)),
            "expected session id in log path, got: {}",
            all_args
        );
    }

    // ── build_recover_command tests ────────────────────────────────

    #[test]
    fn build_recover_command_tails_from_line() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_recover_command("abc-123", 42);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -n +42 ~/.yarr/logs/yarr-abc-123.log"),
            "expected 'tail -n +42' of log file, got: {}",
            all_args
        );
    }

    #[test]
    fn build_recover_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_recover_command("sess-1", 1);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in recover command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_recover_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "550e8400-e29b-41d4";
        let cmd = rt.build_recover_command(session_id, 100);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}.log", session_id)),
            "expected session id in log path, got: {}",
            all_args
        );
    }

    #[test]
    fn build_recover_command_uses_correct_from_line() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_recover_command("abc-123", 999);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -n +999"),
            "expected 'tail -n +999' for from_line=999, got: {}",
            all_args
        );
    }

    #[test]
    fn build_recover_command_does_not_follow() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_recover_command("abc-123", 1);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // recover is a one-shot read, should NOT contain -f (follow)
        assert!(
            !all_args.contains("tail -f"),
            "recover command should not use 'tail -f', got: {}",
            all_args
        );
    }

    // ── build_resume_tail_command tests ────────────────────────────

    #[test]
    fn build_resume_tail_command_follows_from_line() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_resume_tail_command("abc-123", 42);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -f -n +42 ~/.yarr/logs/yarr-abc-123.log"),
            "expected 'tail -f -n +42' of log file, got: {}",
            all_args
        );
    }

    #[test]
    fn build_resume_tail_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_resume_tail_command("sess-1", 1);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in resume tail command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_resume_tail_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "my-session-42";
        let cmd = rt.build_resume_tail_command(session_id, 10);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}.log", session_id)),
            "expected session id in log path, got: {}",
            all_args
        );
    }

    #[test]
    fn build_resume_tail_command_uses_correct_from_line() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_resume_tail_command("abc-123", 500);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("tail -f -n +500"),
            "expected 'tail -f -n +500' for from_line=500, got: {}",
            all_args
        );
    }

    // ── build_cleanup_command tests ────────────────────────────────

    #[test]
    fn build_cleanup_command_removes_log_and_stderr() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_cleanup_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("rm -f"),
            "expected 'rm -f' in cleanup command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("~/.yarr/logs/yarr-abc-123.log"),
            "expected log file path in cleanup command, got: {}",
            all_args
        );
        assert!(
            all_args.contains("/tmp/yarr-abc-123.stderr"),
            "expected stderr file path in cleanup command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_cleanup_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_cleanup_command("sess-1");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in cleanup command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_cleanup_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let cmd = rt.build_cleanup_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        let expected_log = format!("yarr-{}.log", session_id);
        let expected_stderr = format!("yarr-{}.stderr", session_id);

        assert!(
            all_args.contains(&expected_log),
            "expected log filename '{}' in cleanup command, got: {}",
            expected_log, all_args
        );
        assert!(
            all_args.contains(&expected_stderr),
            "expected stderr filename '{}' in cleanup command, got: {}",
            expected_stderr, all_args
        );
    }

    // ── build_get_stderr_command tests ─────────────────────────────

    #[test]
    fn build_get_stderr_command_cats_stderr_file() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_get_stderr_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("cat /tmp/yarr-abc-123.stderr"),
            "expected 'cat /tmp/yarr-abc-123.stderr' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_get_stderr_command_suppresses_errors() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let cmd = rt.build_get_stderr_command("abc-123");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("2>/dev/null"),
            "expected stderr suppression '2>/dev/null' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_get_stderr_command_targets_correct_host() {
        let rt = SshRuntime::new("beth@server", "/home/beth/repos", test_cache());
        let cmd = rt.build_get_stderr_command("sess-1");
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();

        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected host 'beth@server' in get stderr command args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn build_get_stderr_command_substitutes_session_id() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let session_id = "550e8400-e29b-41d4";
        let cmd = rt.build_get_stderr_command(session_id);
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains(&format!("yarr-{}.stderr", session_id)),
            "expected session id in stderr path, got: {}",
            all_args
        );
    }

    // ── RemoteState enum tests ────────────────────────────────────

    #[test]
    fn remote_state_alive_equals_alive() {
        let state = super::RemoteState::Alive;
        assert_eq!(state, super::RemoteState::Alive);
    }

    #[test]
    fn remote_state_completed_ok_equals_completed_ok() {
        let state = super::RemoteState::CompletedOk;
        assert_eq!(state, super::RemoteState::CompletedOk);
    }

    #[test]
    fn remote_state_dead_equals_dead() {
        let state = super::RemoteState::Dead;
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn remote_state_variants_are_not_equal() {
        assert_ne!(super::RemoteState::Alive, super::RemoteState::Dead);
        assert_ne!(super::RemoteState::Alive, super::RemoteState::CompletedOk);
        assert_ne!(super::RemoteState::CompletedOk, super::RemoteState::Dead);
    }

    #[test]
    fn remote_state_is_clone() {
        let state = super::RemoteState::Alive;
        let cloned = state.clone();
        assert_eq!(state, cloned);
    }

    #[test]
    fn remote_state_is_debug() {
        let state = super::RemoteState::Alive;
        let debug = format!("{:?}", state);
        assert!(
            debug.contains("Alive"),
            "expected Debug output to contain 'Alive', got: {}",
            debug
        );
    }

    // ── parse_remote_state tests ──────────────────────────────────

    #[test]
    fn parse_remote_state_alive_output_returns_alive() {
        let state = SshRuntime::parse_remote_state("ALIVE", "");
        assert_eq!(state, super::RemoteState::Alive);
    }

    #[test]
    fn parse_remote_state_alive_ignores_last_log_line() {
        // Even if the last log line is a Result event, ALIVE takes precedence
        let result_json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","session_id":"abc","total_cost_usd":0.041}"#;
        let state = SshRuntime::parse_remote_state("ALIVE", result_json);
        assert_eq!(state, super::RemoteState::Alive);
    }

    #[test]
    fn parse_remote_state_alive_with_trailing_whitespace() {
        let state = SshRuntime::parse_remote_state("ALIVE\n", "some line");
        assert_eq!(state, super::RemoteState::Alive);
    }

    #[test]
    fn parse_remote_state_dead_with_result_event_returns_completed_ok() {
        let result_json = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","session_id":"abc","total_cost_usd":0.041}"#;
        let state = SshRuntime::parse_remote_state("DEAD", result_json);
        assert_eq!(state, super::RemoteState::CompletedOk);
    }

    #[test]
    fn parse_remote_state_dead_with_error_result_returns_completed_ok() {
        // Even an error result is still a Result event — the session completed
        let result_json = r#"{"type":"result","subtype":"error","is_error":true,"duration_ms":500,"num_turns":1,"result":"something went wrong","session_id":"abc","total_cost_usd":0.01}"#;
        let state = SshRuntime::parse_remote_state("DEAD", result_json);
        assert_eq!(state, super::RemoteState::CompletedOk);
    }

    #[test]
    fn parse_remote_state_dead_with_non_result_line_returns_dead() {
        // An assistant event is not a Result event
        let assistant_json = r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"hello"}],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}},"session_id":"abc"}"#;
        let state = SshRuntime::parse_remote_state("DEAD", assistant_json);
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn parse_remote_state_dead_with_empty_last_line_returns_dead() {
        let state = SshRuntime::parse_remote_state("DEAD", "");
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn parse_remote_state_dead_with_invalid_json_returns_dead() {
        let state = SshRuntime::parse_remote_state("DEAD", "this is not json at all");
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn parse_remote_state_dead_with_partial_json_returns_dead() {
        let state = SshRuntime::parse_remote_state("DEAD", r#"{"type":"result","subtype":"#);
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn parse_remote_state_dead_with_system_event_returns_dead() {
        let system_json = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc","model":"claude-opus-4-6","tools":["Bash"]}"#;
        let state = SshRuntime::parse_remote_state("DEAD", system_json);
        assert_eq!(state, super::RemoteState::Dead);
    }

    #[test]
    fn parse_remote_state_dead_with_rate_limit_event_returns_dead() {
        let rate_limit_json = r#"{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1772845200,"rateLimitType":"five_hour"},"session_id":"abc"}"#;
        let state = SshRuntime::parse_remote_state("DEAD", rate_limit_json);
        assert_eq!(state, super::RemoteState::Dead);
    }

    // ── parse_log_lines tests ──────────────────────────────────────

    const SYSTEM_INIT_JSON: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp","session_id":"abc","model":"claude-opus-4-6","tools":["Bash","Read"]}"#;
    const ASSISTANT_TEXT_JSON: &str = r#"{"type":"assistant","message":{"id":"msg_1","role":"assistant","model":"claude-opus-4-6","content":[{"type":"text","text":"hello"}],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":1}},"session_id":"abc"}"#;
    const RESULT_SUCCESS_JSON: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":1929,"duration_api_ms":1887,"num_turns":1,"result":"hello","session_id":"abc","total_cost_usd":0.041}"#;

    #[test]
    fn parse_log_lines_empty_input() {
        let events = parse_log_lines("");
        assert_eq!(events.len(), 0);
    }

    #[test]
    fn parse_log_lines_single_event() {
        let events = parse_log_lines(SYSTEM_INIT_JSON);
        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], StreamEvent::System(_)));
    }

    #[test]
    fn parse_log_lines_multiple_events() {
        let input = format!("{}\n{}\n{}", SYSTEM_INIT_JSON, ASSISTANT_TEXT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Assistant(_)));
        assert!(matches!(events[2], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_skips_empty_lines() {
        let input = format!("{}\n\n{}\n\n{}", SYSTEM_INIT_JSON, ASSISTANT_TEXT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Assistant(_)));
        assert!(matches!(events[2], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_skips_whitespace_only_lines() {
        let input = format!("   \n{}\n\t\t\n{}\n   \t   ", SYSTEM_INIT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_skips_invalid_json() {
        let input = format!("{}\nnot valid json\n{}", SYSTEM_INIT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_skips_partial_json() {
        let input = format!("{}\n{{\"type\":\"result\",\"subtype\":\n{}", SYSTEM_INIT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_handles_trailing_newline() {
        let input = format!("{}\n{}\n", SYSTEM_INIT_JSON, RESULT_SUCCESS_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Result(_)));
    }

    #[test]
    fn parse_log_lines_preserves_event_order() {
        let input = format!("{}\n{}\n{}", RESULT_SUCCESS_JSON, ASSISTANT_TEXT_JSON, SYSTEM_INIT_JSON);
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::Result(_)));
        assert!(matches!(events[1], StreamEvent::Assistant(_)));
        assert!(matches!(events[2], StreamEvent::System(_)));
    }

    #[test]
    fn parse_log_lines_mixed_valid_and_invalid() {
        let input = format!(
            "\n{}\nnot json\n\n{}\n{{broken\n   \n{}\n",
            SYSTEM_INIT_JSON, ASSISTANT_TEXT_JSON, RESULT_SUCCESS_JSON
        );
        let events = parse_log_lines(&input);
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], StreamEvent::System(_)));
        assert!(matches!(events[1], StreamEvent::Assistant(_)));
        assert!(matches!(events[2], StreamEvent::Result(_)));
    }

    // ── build_run_command tests ──────────────────────────────────────

    #[test]
    fn build_run_command_wraps_with_cd() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/some/path");
        let cmd = rt.build_run_command("ls -la", &working_dir, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("cd") && all_args.contains("/some/path") && all_args.contains("&&"),
            "expected cd with /some/path and && in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_run_command_uses_ssh_command() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/some/path");
        let cmd = rt.build_run_command("echo hello", &working_dir, &HashMap::new());
        let std_cmd = cmd.as_std();

        if cfg!(target_os = "windows") {
            assert_eq!(
                std_cmd.get_program(),
                "wsl",
                "on Windows the outer program should be wsl"
            );
        } else {
            assert_eq!(
                std_cmd.get_program(),
                "ssh",
                "on unix the program should be ssh"
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn build_run_command_uses_raw_ssh_without_login_shell() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/some/path");
        let cmd = rt.build_run_command("ls -la", &working_dir, &HashMap::new());
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let last_arg = args_str.last().expect("should have args");

        assert!(
            !last_arg.starts_with("$SHELL -lc "),
            "expected last arg to NOT start with '$SHELL -lc ' (env is pre-resolved), got: {}",
            last_arg
        );
        assert!(
            last_arg.contains("ls -la"),
            "expected command to still contain 'ls -la', got: {}",
            last_arg
        );
    }

    #[test]
    fn build_run_command_escapes_working_dir_with_spaces() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/path with spaces");
        let cmd = rt.build_run_command("ls", &working_dir, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("cd") && all_args.contains("/path with spaces") && all_args.contains("&&"),
            "expected cd with escaped path and && in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_run_command_includes_original_command() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/some/path");
        let cmd = rt.build_run_command("cargo test --release", &working_dir, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("cargo test --release"),
            "expected original command 'cargo test --release' in args, got: {}",
            all_args
        );
    }

    #[test]
    fn build_run_command_escapes_working_dir_with_single_quotes() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let working_dir = PathBuf::from("/home/user/it's a dir");
        let cmd = rt.build_run_command("ls", &working_dir, &HashMap::new());
        let std_cmd = cmd.as_std();

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        // shell_escape("it's a dir") wraps in single quotes and escapes the embedded quote
        assert!(
            all_args.contains("'\\''"),
            "expected shell-escaped single quote in working dir path, got: {}",
            all_args
        );
        assert!(
            all_args.contains("cd "),
            "expected 'cd' in command, got: {}",
            all_args
        );
    }

    // ── env_cache field tests ───────────────────────────────────────

    #[test]
    fn ssh_runtime_new_stores_env_cache() {
        let cache = test_cache();
        cache.insert(
            "other-host".to_string(),
            HashMap::from([("K".to_string(), "V".to_string())]),
        );
        let rt = SshRuntime::new("myhost", "/path", cache.clone());
        // The runtime should store the same Arc — verify by checking the existing entry
        assert!(rt.env_cache.contains_key("other-host"));
    }

    // ── build_tmux_command with resolved env tests ──────────────────

    #[test]
    fn build_tmux_command_includes_resolved_env_exports() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: HashMap::new(),
        };
        let mut resolved_env = HashMap::new();
        resolved_env.insert("HOME".to_string(), "/home/user".to_string());
        resolved_env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());

        let cmd = rt.build_tmux_command("sess-1", &invocation, &resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("export HOME=") && all_args.contains("/home/user"),
            "command should contain resolved HOME export, got: {all_args}"
        );
        assert!(
            all_args.contains("export PATH=") && all_args.contains("/usr/bin:/bin"),
            "command should contain resolved PATH export, got: {all_args}"
        );
    }

    #[test]
    fn build_tmux_command_with_empty_resolved_env_still_works() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: HashMap::new(),
        };
        let resolved_env = HashMap::new();

        let cmd = rt.build_tmux_command("sess-1", &invocation, &resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("claude -p"),
            "command should still contain claude invocation with empty env, got: {all_args}"
        );
    }

    #[test]
    fn build_tmux_command_invocation_env_vars_still_present_with_resolved_env() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: HashMap::from([("MY_VAR".to_string(), "my_value".to_string())]),
        };
        let mut resolved_env = HashMap::new();
        resolved_env.insert("HOME".to_string(), "/home/user".to_string());

        let cmd = rt.build_tmux_command("sess-1", &invocation, &resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("export MY_VAR=") && all_args.contains("my_value"),
            "command should contain invocation env_vars export, got: {all_args}"
        );
        assert!(
            all_args.contains("export HOME=") && all_args.contains("/home/user"),
            "command should also contain resolved env export, got: {all_args}"
        );
    }

    // ── build_run_command with resolved env tests ───────────────────

    #[test]
    fn build_run_command_includes_resolved_env_exports() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let mut resolved_env = HashMap::new();
        resolved_env.insert("HOME".to_string(), "/home/user".to_string());
        resolved_env.insert("PATH".to_string(), "/usr/bin".to_string());

        let cmd = rt.build_run_command("ls -la", &PathBuf::from("/home/user/project"), &resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("export HOME="),
            "command should contain resolved HOME export, got: {all_args}"
        );
        assert!(
            all_args.contains("export PATH="),
            "command should contain resolved PATH export, got: {all_args}"
        );
        assert!(
            all_args.contains("ls -la"),
            "command should still contain the actual command, got: {all_args}"
        );
    }

    #[test]
    fn build_run_command_with_empty_resolved_env() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let resolved_env = HashMap::new();

        let cmd = rt.build_run_command("ls -la", &PathBuf::from("/home/user/project"), &resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("ls -la"),
            "command should contain the actual command even with empty env, got: {all_args}"
        );
    }

    // ── build_health_check_command with resolved env tests ──────────

    #[test]
    fn build_health_check_command_includes_resolved_env_exports() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let mut resolved_env = HashMap::new();
        resolved_env.insert("PATH".to_string(), "/usr/bin:/home/user/.local/bin".to_string());

        let cmd = rt.build_health_check_command(&resolved_env);
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");

        assert!(
            all_args.contains("export PATH="),
            "health check should contain resolved PATH export, got: {all_args}"
        );
        assert!(
            all_args.contains("command -v tmux") && all_args.contains("command -v claude"),
            "health check should still verify tmux and claude, got: {all_args}"
        );
    }

    #[tokio::test]
    async fn resolve_env_returns_cached_value() {
        let cache = test_cache();
        let expected = HashMap::from([
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/home/user".to_string()),
        ]);
        cache.insert("devbox".to_string(), expected.clone());
        let rt = SshRuntime::new("devbox", "/path", cache);
        let result = rt.resolve_env().await.unwrap();
        assert_eq!(result, expected, "resolve_env should return cached value");
    }

    // ── env_warning tests (Task 7: env warning surface) ─────────────

    #[tokio::test]
    async fn env_warning_returns_none_when_cached() {
        // When the cache already contains an entry for the host,
        // resolve_env() returns the cached value without attempting a
        // snapshot. Therefore env_warning() should return None — no
        // failure occurred.
        let cache = test_cache();
        cache.insert(
            "devbox".to_string(),
            HashMap::from([("PATH".to_string(), "/usr/bin".to_string())]),
        );
        let rt = SshRuntime::new("devbox", "/home/user/project", cache);

        let result = rt.resolve_env().await.unwrap();
        assert!(
            !result.is_empty(),
            "resolve_env should return cached (non-empty) env"
        );

        let warning = rt.env_warning();
        assert_eq!(
            warning, None,
            "env_warning() should be None when env was served from cache"
        );
    }

    #[tokio::test]
    async fn env_warning_returns_message_on_snapshot_failure() {
        // When the cache is empty and the SSH host is unreachable,
        // resolve_env() should gracefully fall back to an empty map
        // and set a warning message accessible via env_warning().
        //
        // In cargo test there is no SSH server, so ssh_command_raw
        // to a nonexistent host will fail, triggering the fallback path.
        let cache = test_cache();
        let rt = SshRuntime::new(
            "nonexistent-host-that-will-never-resolve-test",
            "/fake/path",
            cache,
        );

        let result = rt.resolve_env().await;
        assert!(
            result.is_ok(),
            "resolve_env should return Ok even on snapshot failure (graceful fallback)"
        );

        let env = result.unwrap();
        assert!(
            env.is_empty(),
            "on snapshot failure the fallback should return an empty map"
        );

        let warning = rt.env_warning();
        assert!(
            warning.is_some(),
            "env_warning() should return Some(...) after a snapshot failure"
        );
        let msg = warning.unwrap();
        assert!(
            !msg.is_empty(),
            "warning message should not be empty"
        );
    }

    #[test]
    fn build_tmux_command_includes_effort_level() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: Some("high".to_string()),
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            all_args.contains("--effort") && all_args.contains("high"),
            "expected '--effort high' in command, got: {}",
            all_args
        );
    }

    #[test]
    fn build_tmux_command_excludes_effort_when_none() {
        let rt = SshRuntime::new("devbox", "/home/user/project", test_cache());
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            effort_level: None,
            extra_args: vec![],
            env_vars: std::collections::HashMap::new(),
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation, &HashMap::new());
        let std_cmd = cmd.as_std();
        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            !all_args.contains("--effort"),
            "expected no '--effort' flag when effort_level is None, got: {}",
            all_args
        );
    }
}
