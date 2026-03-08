use anyhow::Result;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{ClaudeInvocation, CommandOutput, ProcessExit, RunningProcess, RuntimeProvider, TaskAbortHandle};
use crate::output::StreamEvent;

pub struct LocalRuntime {
    claude_bin: String,
}

impl LocalRuntime {
    pub fn new() -> Self {
        Self {
            claude_bin: "claude".to_string(),
        }
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for LocalRuntime {
    fn name(&self) -> &str {
        "local"
    }

    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let prompt = invocation.prompt.clone();
        let start = std::time::Instant::now();

        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
        ];

        if let Some(ref model) = invocation.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }

        args.extend(invocation.extra_args.clone());

        let mut cmd = Command::new(&self.claude_bin);
        cmd.args(&args)
            .current_dir(&invocation.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.envs(&invocation.env_vars);
        let mut child = cmd.spawn()?;

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
            let _ = stdin_task.await;

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

        let abort_handle = TaskAbortHandle(completion.abort_handle());
        Ok(RunningProcess {
            events: rx,
            completion,
            abort_handle: Box::new(abort_handle),
        })
    }

    async fn health_check(&self) -> Result<()> {
        let output = Command::new("which")
            .arg(&self.claude_bin)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "claude binary '{}' not found. Is Claude Code installed?",
                self.claude_bin
            );
        }
        Ok(())
    }

    async fn run_command(
        &self,
        command: &str,
        working_dir: &std::path::Path,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput> {
        let child = Command::new("bash")
            .arg("-c")
            .arg(command)
            .current_dir(working_dir)
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
                anyhow::bail!("Command timed out after {:?}", timeout)
            }
        }
    }
}
