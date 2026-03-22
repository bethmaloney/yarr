use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tracing::instrument;

use super::{
    get_or_init_local_env, tokio_command, ClaudeInvocation, CommandOutput, ProcessExit,
    RunningProcess, RuntimeProvider, TaskAbortHandle,
};
use crate::output::StreamEvent;

pub struct LocalRuntime {
    claude_bin: String,
}

impl Default for LocalRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalRuntime {
    #[must_use] 
    pub fn new() -> Self {
        Self {
            claude_bin: "claude".to_string(),
        }
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for LocalRuntime {
    fn name(&self) -> &'static str {
        "local"
    }

    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        Ok(get_or_init_local_env().await.clone())
    }

    fn env_warning(&self) -> Option<String> {
        super::get_local_env_warning()
    }

    #[instrument(skip(self, invocation), fields(working_dir = %invocation.working_dir.display()))]
    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let env = self.resolve_env().await?;
        let prompt = invocation.prompt.clone();
        let start = std::time::Instant::now();
        tracing::debug!(
            working_dir = %invocation.working_dir.display(),
            model = ?invocation.model,
            extra_args = ?invocation.extra_args,
            "local spawn_claude"
        );

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

        if let Some(ref effort) = invocation.effort_level {
            args.push("--effort".to_string());
            args.push(effort.clone());
        }

        args.extend(invocation.extra_args.clone());

        let mut cmd = tokio_command(&self.claude_bin);
        cmd.args(&args)
            .current_dir(&invocation.working_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        cmd.envs(&env);
        cmd.envs(&invocation.env_vars);
        let mut child = cmd.spawn()?;
        tracing::info!(pid = child.id(), "claude process spawned");

        // Pipe prompt via stdin, then close it
        let mut stdin = child.stdin.take().expect("stdin was piped");
        let stdin_task = tokio::spawn(async move {
            tracing::debug!(bytes = prompt.len(), "writing prompt to stdin");
            if let Err(e) = stdin.write_all(prompt.as_bytes()).await {
                tracing::warn!("failed to write prompt to stdin: {}", e);
            }
            if let Err(e) = stdin.shutdown().await {
                tracing::warn!("failed to shutdown stdin: {}", e);
            }
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
            tracing::debug!("stdout reader finished");
        });

        // Spawn a task that waits for process exit
        let completion = tokio::spawn(async move {
            let _ = stdin_task.await;
            tracing::debug!("stdin task completed");

            let mut stderr_buf = String::new();
            let mut stderr_reader = BufReader::new(stderr);
            let mut stderr_line = String::new();
            let mut stderr_line_count: usize = 0;
            while let Ok(n) = stderr_reader.read_line(&mut stderr_line).await {
                if n == 0 {
                    break;
                }
                stderr_buf.push_str(&stderr_line);
                stderr_line.clear();
                stderr_line_count += 1;
            }
            tracing::debug!(lines = stderr_line_count, "stderr collection completed");

            let status = child.wait().await?;
            let exit_code = status.code().unwrap_or(-1);
            tracing::debug!(exit_code = exit_code, "child process wait completed");
            let _ = reader_task.await;
            let elapsed = start.elapsed();

            tracing::debug!(exit_code = exit_code, wall_time_ms = elapsed.as_secs() * 1000 + u64::from(elapsed.subsec_millis()), "process completed successfully");
            Ok(ProcessExit {
                exit_code,
                wall_time_ms: elapsed.as_secs() * 1000 + u64::from(elapsed.subsec_millis()),
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

    async fn read_file(
        &self,
        file_path: &str,
        working_dir: &std::path::Path,
    ) -> Result<String> {
        let full_path = working_dir.join(file_path);
        Ok(tokio::fs::read_to_string(&full_path).await?)
    }

    #[instrument(skip(self))]
    async fn health_check(&self) -> Result<()> {
        let env = self.resolve_env().await?;
        tracing::debug!(claude_bin = %self.claude_bin, "checking for claude binary");
        let output = tokio_command("which")
            .arg(&self.claude_bin)
            .envs(&env)
            .output()
            .await?;

        if !output.status.success() {
            tracing::error!(claude_bin = %self.claude_bin, "claude binary not found");
            anyhow::bail!(
                "claude binary '{}' not found. Is Claude Code installed?",
                self.claude_bin
            );
        }
        tracing::debug!(claude_bin = %self.claude_bin, "claude binary found");
        Ok(())
    }

    #[instrument(skip(self, command), fields(timeout_secs = timeout.as_secs()))]
    async fn run_command(
        &self,
        command: &str,
        working_dir: &std::path::Path,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput> {
        tracing::debug!(command = %command, working_dir = %working_dir.display(), timeout_secs = timeout.as_secs(), "running command");
        let env = self.resolve_env().await?;
        let child = tokio_command("bash")
            .arg("-c")
            .arg(command)
            .current_dir(working_dir)
            .envs(&env)
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
                tracing::warn!(command = %command, timeout_secs = timeout.as_secs(), "command timed out");
                anyhow::bail!("Command timed out after {timeout:?}")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeProvider;

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn local_runtime_resolve_env_returns_non_empty() {
        let runtime = LocalRuntime::new();
        let env = runtime
            .resolve_env()
            .await
            .expect("resolve_env should succeed");

        assert!(
            !env.is_empty(),
            "resolved env should not be empty"
        );

        assert!(
            env.contains_key("PATH") || env.contains_key("Path"),
            "resolved env should contain PATH, got keys: {:?}",
            env.keys().take(10).collect::<Vec<_>>()
        );
    }

    #[tokio::test]
    async fn local_runtime_resolve_env_is_cached() {
        let runtime = LocalRuntime::new();
        let env1 = runtime
            .resolve_env()
            .await
            .expect("first resolve_env should succeed");
        let env2 = runtime
            .resolve_env()
            .await
            .expect("second resolve_env should succeed");

        assert_eq!(
            env1, env2,
            "two calls to resolve_env should return identical data"
        );
    }

    #[tokio::test]
    #[cfg(not(target_os = "windows"))]
    async fn local_runtime_resolve_env_contains_home() {
        // Only meaningful when HOME is set in the process env (Linux/macOS).
        // The resolved env — whether from snapshot or fallback — should include it.
        if std::env::var("HOME").is_err() {
            // Skip on platforms where HOME is not set (e.g. Windows without WSL).
            return;
        }

        let runtime = LocalRuntime::new();
        let env = runtime
            .resolve_env()
            .await
            .expect("resolve_env should succeed");

        assert!(
            env.contains_key("HOME"),
            "resolved env should contain HOME when it is set in the process env"
        );
    }
}
