use anyhow::Result;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{ClaudeInvocation, ProcessExit, RunningProcess, RuntimeProvider};
use crate::output::StreamEvent;

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
    fn build_command(&self, invocation: &ClaudeInvocation) -> String {
        let wsl_dir = to_wsl_path(&invocation.working_dir);

        let mut parts = vec![
            format!("cd {}", shell_escape(&wsl_dir)),
            format!(
                "&& {} -p --output-format stream-json --verbose",
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
            .args(["-e", "bash", "-c", &cmd_str])
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

            // Collect stderr
            let mut stderr_buf = String::new();
            let mut stderr_reader = BufReader::new(stderr);
            let mut stderr_line = String::new();
            while let Ok(n) = stderr_reader.read_line(&mut stderr_line).await {
                if n == 0 {
                    break;
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

        let abort_handle = completion.abort_handle();
        Ok(RunningProcess {
            events: rx,
            completion,
            abort_handle,
        })
    }

    async fn health_check(&self) -> Result<()> {
        let output = Command::new("wsl")
            .args(["-e", "which", &self.claude_bin])
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
