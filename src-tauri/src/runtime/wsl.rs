use anyhow::Result;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{AbortHandle, ClaudeInvocation, ProcessExit, RunningProcess, RuntimeProvider};
use crate::output::StreamEvent;

/// Abort handle that kills the WSL child process tree before aborting the task.
struct WslAbortHandle {
    task_handle: tokio::task::AbortHandle,
    wsl_pid: Arc<std::sync::Mutex<Option<u32>>>,
}

impl AbortHandle for WslAbortHandle {
    fn abort(&self) {
        // Try to kill the process tree inside WSL before aborting the task
        if let Some(pid) = *self.wsl_pid.lock().unwrap() {
            tracing::info!("Killing WSL process tree (pid={pid})");
            // Use kill with negative PID to kill the process group, fall back to single kill
            let _ = std::process::Command::new("wsl")
                .args(["-e", "kill", "--", &format!("-{pid}")])
                .output();
            let _ = std::process::Command::new("wsl")
                .args(["-e", "kill", "-9", &pid.to_string()])
                .output();
        }
        self.task_handle.abort();
    }
}

pub struct WslRuntime {
    claude_bin: String,
}

impl WslRuntime {
    pub fn new() -> Self {
        Self {
            claude_bin: "claude".to_string(),
        }
    }

    pub fn with_claude_bin(mut self, bin: impl Into<String>) -> Self {
        self.claude_bin = bin.into();
        self
    }

    /// Build the shell command string for the Claude invocation.
    /// The prompt is piped via stdin, so it's not included in the command.
    /// Echoes `__PID__=<pid>` to stderr so we can kill the process tree inside WSL.
    fn build_command(&self, invocation: &ClaudeInvocation) -> String {
        let wsl_dir = to_wsl_path(&invocation.working_dir);

        let mut parts = vec![
            format!("cd {}", shell_escape(&wsl_dir)),
            format!(
                "&& echo __PID__=$$ >&2 && exec {} -p --output-format stream-json --verbose",
                shell_escape(&self.claude_bin)
            ),
        ];

        if let Some(ref model) = invocation.model {
            parts.push(format!("--model {}", shell_escape(model)));
        }

        for arg in &invocation.extra_args {
            parts.push(shell_escape(arg));
        }

        parts.join(" ")
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for WslRuntime {
    fn name(&self) -> &str {
        "wsl"
    }

    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let cmd_str = self.build_command(invocation);
        let prompt = invocation.prompt.clone();
        let start = std::time::Instant::now();

        let mut child = Command::new("wsl")
            .args(["-e", "bash", "-lc", &cmd_str])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        // Pipe prompt via stdin, then close it
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stdin_task = tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });

        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");

        let (tx, rx) = mpsc::channel::<StreamEvent>(64);

        // Track the WSL-side PID so we can kill the process tree inside WSL
        let wsl_pid: Arc<std::sync::Mutex<Option<u32>>> = Arc::new(std::sync::Mutex::new(None));
        let wsl_pid_for_completion = wsl_pid.clone();

        // Spawn a task that reads stdout line-by-line and sends parsed events
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
                            break; // receiver dropped
                        }
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse stream-json line: {e}\n  line: {line}");
                    }
                }
            }
        });

        // Spawn a task that waits for process exit
        let completion = tokio::spawn(async move {
            // Wait for stdin to finish writing
            let _ = stdin_task.await;

            // Collect stderr, extracting the WSL-side PID from the __PID__=<n> marker
            let mut stderr_buf = String::new();
            let mut stderr_reader = BufReader::new(stderr);
            let mut stderr_line = String::new();
            while let Ok(n) = stderr_reader.read_line(&mut stderr_line).await {
                if n == 0 {
                    break;
                }
                if let Some(pid_str) = stderr_line.trim().strip_prefix("__PID__=") {
                    if let Ok(pid) = pid_str.parse::<u32>() {
                        *wsl_pid_for_completion.lock().unwrap() = Some(pid);
                    }
                    stderr_line.clear();
                    continue;
                }
                stderr_buf.push_str(&stderr_line);
                stderr_line.clear();
            }

            let status = child.wait().await?;
            let _ = reader_task.await;
            let elapsed = start.elapsed();

            Ok(ProcessExit {
                exit_code: status.code().unwrap_or(-1),
                wall_time_ms: elapsed.as_millis() as u64,
                stderr: stderr_buf,
            })
        });

        let abort_handle = WslAbortHandle {
            task_handle: completion.abort_handle(),
            wsl_pid,
        };
        Ok(RunningProcess {
            events: rx,
            completion,
            abort_handle: Box::new(abort_handle),
        })
    }

    async fn health_check(&self) -> Result<()> {
        let output = Command::new("wsl")
            .args(["-e", "bash", "-lc", &format!("which {}", shell_escape(&self.claude_bin))])
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "claude binary '{}' not found in WSL. Is Claude Code installed?",
                self.claude_bin
            );
        }
        Ok(())
    }
}

/// Convert a Windows-style path to a WSL path if needed
fn to_wsl_path(path: &std::path::Path) -> String {
    let s = path.to_string_lossy();
    if s.starts_with('/') {
        return s.to_string();
    }
    // Convert \\wsl.localhost\Distro\home\... or \\wsl$\Distro\home\... -> /home/...
    if s.starts_with("\\\\wsl.localhost\\") || s.starts_with("\\\\wsl$\\") {
        let without_prefix = if s.starts_with("\\\\wsl.localhost\\") {
            &s["\\\\wsl.localhost\\".len()..]
        } else {
            &s["\\\\wsl$\\".len()..]
        };
        // Skip the distro name (everything up to the next backslash)
        if let Some(pos) = without_prefix.find('\\') {
            let rest = &without_prefix[pos..];
            return rest.replace('\\', "/");
        }
        return "/".to_string();
    }
    // Convert C:\foo\bar -> /mnt/c/foo/bar
    if s.len() >= 3 && s.as_bytes()[1] == b':' {
        let drive = s.as_bytes()[0].to_ascii_lowercase() as char;
        let rest = &s[3..].replace('\\', "/");
        return format!("/mnt/{drive}/{rest}");
    }
    s.to_string()
}

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn test_to_wsl_path_unc_wsl_localhost() {
        let path = Path::new("\\\\wsl.localhost\\Ubuntu-24.04\\home\\beth\\repos\\yarr");
        assert_eq!(to_wsl_path(path), "/home/beth/repos/yarr");
    }

    #[test]
    fn test_to_wsl_path_unc_wsl_dollar() {
        let path = Path::new("\\\\wsl$\\Ubuntu-24.04\\home\\beth\\repos\\yarr");
        assert_eq!(to_wsl_path(path), "/home/beth/repos/yarr");
    }

    #[test]
    fn test_to_wsl_path_drive_letter() {
        let path = Path::new("C:\\Users\\beth\\repos\\yarr");
        assert_eq!(to_wsl_path(path), "/mnt/c/Users/beth/repos/yarr");
    }

    #[test]
    fn test_to_wsl_path_unix() {
        let path = Path::new("/home/beth/repos/yarr");
        assert_eq!(to_wsl_path(path), "/home/beth/repos/yarr");
    }
}
