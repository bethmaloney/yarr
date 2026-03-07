use anyhow::Result;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{AbortHandle, ClaudeInvocation, ProcessExit, RunningProcess, RuntimeProvider, TaskAbortHandle};
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
/// - On Linux/macOS: `ssh <options> <host> <remote_cmd>`
/// - On Windows: `wsl -e bash -lc "ssh <options> <host> <remote_cmd>"`
///
/// SSH options include `-o BatchMode=yes -o StrictHostKeyChecking=accept-new`
/// for non-interactive use.
///
/// `remote_cmd` is passed directly to SSH which forwards it to the remote shell.
/// The caller is responsible for properly escaping `remote_cmd` contents
/// (e.g. using `shell_escape()` for individual arguments within the command).
pub fn ssh_command(host: &str, remote_cmd: &str) -> Command {
    if cfg!(target_os = "windows") {
        let ssh_str = format!(
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
            shell_escape(host),
            remote_cmd
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

pub struct SshRuntime {
    pub ssh_host: String,
    pub remote_path: String,
}

/// Abort handle that kills the remote tmux session before aborting the task.
struct SshAbortHandle {
    task_handle: tokio::task::AbortHandle,
    ssh_host: String,
    session_id: String,
}

impl AbortHandle for SshAbortHandle {
    fn abort(&self) {
        let kill_cmd = format!("tmux kill-session -t yarr-{}", self.session_id);
        tracing::info!("Killing remote tmux session yarr-{}", self.session_id);
        if cfg!(target_os = "windows") {
            let ssh_str = format!(
                "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
                shell_escape(&self.ssh_host),
                &kill_cmd
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
                .arg(&self.ssh_host)
                .arg(&kill_cmd)
                .output();
        }
        self.task_handle.abort();
    }
}

impl SshRuntime {
    pub fn new(host: &str, remote_path: &str) -> Self {
        Self {
            ssh_host: host.to_string(),
            remote_path: remote_path.to_string(),
        }
    }

    pub fn build_mkdir_command(&self) -> Command {
        ssh_command(&self.ssh_host, "mkdir -p ~/.yarr/logs")
    }

    pub fn build_tmux_command(&self, session_id: &str, invocation: &ClaudeInvocation) -> Command {
        let escaped_prompt = shell_escape(&invocation.prompt);
        let escaped_remote_path = shell_escape(&self.remote_path);

        let mut claude_cmd = String::from("claude -p --output-format stream-json --verbose");

        if let Some(ref model) = invocation.model {
            claude_cmd.push_str(&format!(" --model {}", shell_escape(model)));
        }

        for arg in &invocation.extra_args {
            claude_cmd.push_str(&format!(" {}", shell_escape(arg)));
        }

        claude_cmd.push_str(&format!(" {}", escaped_prompt));

        // Build the inner command that runs inside tmux (executed by sh -c).
        // Values use shell_escape for proper quoting at the tmux shell layer.
        let tmux_body = format!(
            "cd {escaped_remote_path} && {claude_cmd} 2>/tmp/yarr-{session_id}.stderr | tee ~/.yarr/logs/yarr-{session_id}.log"
        );

        // shell_escape the entire tmux body so it is passed as a single
        // properly-quoted argument to tmux through the SSH remote shell.
        // The SSH remote shell strips the outer quoting layer, and tmux
        // passes the result to sh -c which strips the inner quoting layer.
        let remote_cmd = format!(
            "tmux new-session -d -s yarr-{session_id} {escaped_body}",
            escaped_body = shell_escape(&tmux_body)
        );

        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_tail_command(&self, session_id: &str) -> Command {
        let remote_cmd = format!("tail -f ~/.yarr/logs/yarr-{session_id}.log");
        ssh_command(&self.ssh_host, &remote_cmd)
    }

    pub fn build_health_check_command(&self) -> Command {
        ssh_command(
            &self.ssh_host,
            "command -v tmux && command -v claude && echo OK",
        )
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
        Ok(parse_log_lines(&stdout))
    }

    /// Resume tailing the log file from the given line, returning a RunningProcess.
    pub async fn resume_tail(
        &self,
        session_id: &str,
        from_line: u64,
    ) -> Result<RunningProcess> {
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
        let output = self.build_cleanup_command(session_id).output().await?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Failed to clean up remote files: {}", stderr);
        }
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

    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let start = std::time::Instant::now();
        let session_id = uuid::Uuid::new_v4().to_string();

        // Create log directory and touch the log file so tail -f doesn't race
        let setup_cmd = format!(
            "mkdir -p ~/.yarr/logs && touch ~/.yarr/logs/yarr-{session_id}.log"
        );
        let setup_output = ssh_command(&self.ssh_host, &setup_cmd).output().await?;
        if !setup_output.status.success() {
            let stderr = String::from_utf8_lossy(&setup_output.stderr);
            anyhow::bail!("Failed to set up remote log directory: {}", stderr);
        }

        // Start tmux session with claude on remote
        let tmux_output = self
            .build_tmux_command(&session_id, invocation)
            .output()
            .await?;
        if !tmux_output.status.success() {
            let stderr = String::from_utf8_lossy(&tmux_output.stderr);
            anyhow::bail!("Failed to start remote tmux session: {}", stderr);
        }

        // Tail the log file
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
            session_id,
        };
        Ok(RunningProcess {
            events: rx,
            completion,
            abort_handle: Box::new(abort_handle),
        })
    }

    async fn health_check(&self) -> Result<()> {
        let output = self.build_health_check_command().output().await?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        if !stdout.contains("OK") {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!(
                "SSH health check failed on {}: {}",
                self.ssh_host,
                if stderr.trim().is_empty() {
                    "tmux or claude not found".to_string()
                } else {
                    stderr.trim().to_string()
                }
            );
        }
        Ok(())
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

    // ── SshRuntime construction tests ────────────────────────────

    use crate::runtime::{ClaudeInvocation, RuntimeProvider};
    use std::path::PathBuf;

    #[test]
    fn ssh_runtime_new_stores_host() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project");
        assert_eq!(rt.ssh_host, "devbox.example.com");
    }

    #[test]
    fn ssh_runtime_new_stores_remote_path() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project");
        assert_eq!(rt.remote_path, "/home/user/project");
    }

    #[test]
    fn ssh_runtime_name_returns_ssh() {
        let rt = SshRuntime::new("devbox.example.com", "/home/user/project");
        assert_eq!(rt.name(), "ssh");
    }

    #[test]
    fn ssh_runtime_new_with_user_at_host() {
        let rt = SshRuntime::new("beth@devbox.example.com", "/home/beth/repos");
        assert_eq!(rt.ssh_host, "beth@devbox.example.com");
    }

    #[test]
    fn ssh_runtime_new_with_ip_address() {
        let rt = SshRuntime::new("192.168.1.100", "/opt/project");
        assert_eq!(rt.ssh_host, "192.168.1.100");
    }

    // ── SshRuntime command building tests ────────────────────────

    #[test]
    fn build_mkdir_command_creates_log_directory() {
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command(session_id, &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "do something".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command(session_id, &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let session_id = "abc-123";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command(session_id, &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: Some("claude-sonnet-4-20250514".to_string()),
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![
                "--max-turns".to_string(),
                "5".to_string(),
            ],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug in main.rs".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let cmd = rt.build_health_check_command();
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
        let rt = SshRuntime::new("user@10.0.0.1", "/opt/repos/app");
        let cmd = rt.build_health_check_command();
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
        let rt = SshRuntime::new("devbox", "/home/user/my project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/my project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug in it's parser".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: r#"Fix the "broken" function"#.to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "Run $(whoami) && echo $HOME | cat".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let session_id = "550e8400-e29b-41d4-a716-446655440000";
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command(session_id, &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: Some("claude-opus-4-6".to_string()),
            extra_args: vec![
                "--allowedTools".to_string(),
                "Bash,Read,Write".to_string(),
            ],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("deploy@prod-server.internal", "/srv/app");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/srv/app"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "hello".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let cmd = rt.build_health_check_command();
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "Fix the bug.\nThen run the tests.\nReport results.".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
        let invocation = ClaudeInvocation {
            prompt: "Explain what `main()` does".to_string(),
            working_dir: PathBuf::from("/home/user/project"),
            model: None,
            extra_args: vec![],
        };
        let cmd = rt.build_tmux_command("sess-1", &invocation);
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
        let rt = SshRuntime::new("beth@server", "/home/beth/repos");
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
        let rt = SshRuntime::new("devbox", "/home/user/project");
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
}
