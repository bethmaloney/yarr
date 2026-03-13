use anyhow::Result;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

use super::{get_or_init_local_env, AbortHandle, ClaudeInvocation, CommandOutput, ProcessExit, RunningProcess, RuntimeProvider};
use crate::output::StreamEvent;

/// Abort handle that kills the WSL child process tree before aborting the task.
struct WslAbortHandle {
    task_handle: tokio::task::AbortHandle,
    wsl_pid: Arc<std::sync::Mutex<Option<u32>>>,
}

impl AbortHandle for WslAbortHandle {
    fn abort(&self) {
        // Abort the tokio task immediately — don't wait for WSL kill commands
        self.task_handle.abort();

        // Fire-and-forget the WSL kill commands in a background thread so they
        // can't block the runtime if WSL is unresponsive.
        if let Some(pid) = *self.wsl_pid.lock().unwrap() {
            tracing::info!("Killing WSL process tree (pid={pid})");
            std::thread::spawn(move || {
                // Kill process group, then force-kill the individual process.
                // Use .output() which blocks, but that's fine — this is a
                // dedicated thread that won't stall the async runtime.
                // If WSL is hung these threads will linger but won't block anything.
                let _ = std::process::Command::new("wsl")
                    .args(["-e", "kill", "--", &format!("-{pid}")])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .output();
                let _ = std::process::Command::new("wsl")
                    .args(["-e", "kill", "-9", &pid.to_string()])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .output();
            });
        }
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
    fn build_command(&self, invocation: &ClaudeInvocation, resolved_env: &HashMap<String, String>) -> String {
        let wsl_dir = to_wsl_path(&invocation.working_dir);

        let mut parts: Vec<String> = Vec::new();

        // Resolved env exports first (can be overridden by invocation env_vars)
        parts.extend(env_export_parts(resolved_env));

        // cd to working directory
        parts.push(format!("cd {}", shell_escape(&wsl_dir)));

        // Invocation-specific env vars (override resolved env)
        for (key, val) in &invocation.env_vars {
            parts.push(format!("export {}={}", key, shell_escape(val)));
        }

        // Main command
        let mut cmd_parts = vec![format!(
            "echo __PID__=$$ >&2 && exec {} -p --output-format stream-json --verbose",
            shell_escape(&self.claude_bin)
        )];
        if let Some(ref model) = invocation.model {
            cmd_parts.push(format!("--model {}", shell_escape(model)));
        }
        for arg in &invocation.extra_args {
            cmd_parts.push(shell_escape(arg));
        }
        parts.push(cmd_parts.join(" "));

        parts.join(" && ")
    }
}

#[async_trait::async_trait]
impl RuntimeProvider for WslRuntime {
    fn name(&self) -> &str {
        "wsl"
    }

    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess> {
        let env = self.resolve_env().await?;
        let cmd_str = self.build_command(invocation, &env);
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
        let env = self.resolve_env().await?;
        let mut parts = env_export_parts(&env);
        parts.push(format!("which {}", shell_escape(&self.claude_bin)));
        let cmd_str = parts.join(" && ");

        let output = Command::new("wsl")
            .args(["-e", "bash", "-c", &cmd_str])
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

    async fn run_command(
        &self,
        command: &str,
        working_dir: &std::path::Path,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput> {
        let env = self.resolve_env().await?;
        let wsl_dir = to_wsl_path(working_dir);
        tracing::debug!(
            working_dir = %working_dir.display(),
            wsl_dir = %wsl_dir,
            command = %command,
            "WslRuntime::run_command starting"
        );
        let mut parts = env_export_parts(&env);
        parts.push(format!("cd {}", shell_escape(&wsl_dir)));
        parts.push(command.to_string());
        let cmd_str = parts.join(" && ");

        let child = Command::new("wsl")
            .args(["-e", "bash", "-c", &cmd_str])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;

        let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
        match result {
            Ok(Ok(output)) => {
                let exit_code = output.status.code().unwrap_or(-1);
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if exit_code == 0 {
                    tracing::debug!(exit_code, "WslRuntime::run_command succeeded");
                } else {
                    tracing::warn!(exit_code, stderr = %stderr, command = %command, "WslRuntime::run_command failed");
                }
                Ok(CommandOutput {
                    exit_code,
                    stdout: String::from_utf8_lossy(&output.stdout).to_string(),
                    stderr,
                })
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => {
                tracing::warn!(command = %command, timeout = ?timeout, "WslRuntime::run_command timed out");
                // child is dropped here, kill_on_drop(true) ensures cleanup
                anyhow::bail!("Command timed out after {:?}", timeout)
            }
        }
    }

    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        Ok(get_or_init_local_env().await.clone())
    }

    fn env_warning(&self) -> Option<String> {
        super::get_local_env_warning()
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

fn env_export_parts(env: &HashMap<String, String>) -> Vec<String> {
    env.iter()
        .map(|(key, val)| format!("export {}={}", key, shell_escape(val)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;

    use crate::runtime::RuntimeProvider;

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

    // ---------------------------------------------------------------
    // Tests for env_export_parts helper function
    // ---------------------------------------------------------------

    #[test]
    fn test_env_export_parts_basic() {
        let mut map = HashMap::new();
        map.insert("HOME".to_string(), "/home/user".to_string());
        map.insert("PATH".to_string(), "/usr/bin".to_string());

        let parts = env_export_parts(&map);

        assert_eq!(parts.len(), 2, "should produce one export per entry");

        // Each entry should be a valid export statement
        for part in parts.iter() {
            assert!(
                part.starts_with("export "),
                "each part should start with 'export ', got: {part}"
            );
        }

        // Check that both entries are present (order is not guaranteed for HashMap)
        let joined = parts.join("\n");
        assert!(
            joined.contains("export HOME='/home/user'"),
            "should contain HOME export, got: {joined}"
        );
        assert!(
            joined.contains("export PATH='/usr/bin'"),
            "should contain PATH export, got: {joined}"
        );
    }

    #[test]
    fn test_env_export_parts_empty() {
        let map = HashMap::new();
        let parts = env_export_parts(&map);
        assert!(
            parts.is_empty(),
            "empty HashMap should produce empty Vec, got: {parts:?}"
        );
    }

    #[test]
    fn test_env_export_parts_escapes_special_chars() {
        let mut map = HashMap::new();
        map.insert("GREETING".to_string(), "it's a test".to_string());

        let parts = env_export_parts(&map);

        assert_eq!(parts.len(), 1);
        // shell_escape wraps in single quotes and escapes inner single quotes as '\''
        // So "it's a test" becomes 'it'\''s a test'
        let expected = "export GREETING='it'\\''s a test'";
        assert_eq!(
            parts[0], expected,
            "single quotes in values should be properly escaped"
        );
    }

    // ---------------------------------------------------------------
    // Tests for build_command with resolved env parameter
    // ---------------------------------------------------------------

    #[test]
    fn test_build_command_includes_resolved_env() {
        let runtime = WslRuntime::new();
        let invocation = ClaudeInvocation {
            prompt: "test prompt".to_string(),
            working_dir: "/home/beth/project".into(),
            model: None,
            extra_args: vec![],
            env_vars: HashMap::new(),
        };
        let mut resolved_env = HashMap::new();
        resolved_env.insert("HOME".to_string(), "/home/beth".to_string());
        resolved_env.insert("PATH".to_string(), "/usr/bin:/bin".to_string());

        let cmd = runtime.build_command(&invocation, &resolved_env);

        // The command should contain the resolved env exports
        assert!(
            cmd.contains("export HOME='/home/beth'"),
            "command should contain resolved HOME export, got: {cmd}"
        );
        assert!(
            cmd.contains("export PATH='/usr/bin:/bin'"),
            "command should contain resolved PATH export, got: {cmd}"
        );
    }

    #[test]
    fn test_build_command_resolved_env_before_invocation_vars() {
        let runtime = WslRuntime::new();
        let mut inv_env = HashMap::new();
        inv_env.insert("OVERRIDE".to_string(), "new".to_string());

        let invocation = ClaudeInvocation {
            prompt: "test prompt".to_string(),
            working_dir: "/home/beth/project".into(),
            model: None,
            extra_args: vec![],
            env_vars: inv_env,
        };

        let mut resolved_env = HashMap::new();
        resolved_env.insert("OVERRIDE".to_string(), "old".to_string());
        resolved_env.insert("OTHER".to_string(), "val".to_string());

        let cmd = runtime.build_command(&invocation, &resolved_env);

        // Find positions of the resolved env export for OVERRIDE and the
        // invocation env export for OVERRIDE. The resolved env should come
        // first so that the invocation vars can override them.
        let resolved_pos = cmd
            .find("export OVERRIDE='old'")
            .expect("command should contain resolved OVERRIDE export");
        let invocation_pos = cmd
            .find("export OVERRIDE='new'")
            .expect("command should contain invocation OVERRIDE export");

        assert!(
            resolved_pos < invocation_pos,
            "resolved env exports (pos={resolved_pos}) should appear before \
             invocation env exports (pos={invocation_pos}) in the command: {cmd}"
        );

        // OTHER from resolved env should also be present
        assert!(
            cmd.contains("export OTHER='val'"),
            "command should contain resolved OTHER export, got: {cmd}"
        );
    }

    // ---------------------------------------------------------------
    // Test for WslRuntime::resolve_env
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn test_wsl_resolve_env_returns_non_empty() {
        let runtime = WslRuntime::new();
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
}
