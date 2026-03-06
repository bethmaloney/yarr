use anyhow::Result;
use std::path::Path;
use std::process::Stdio;
use tokio::process::Command;

use super::{ProcessOutput, RuntimeProvider};

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

    /// Convert a Windows-style path to a WSL path if needed
    fn to_wsl_path(path: &Path) -> String {
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
}

#[async_trait::async_trait]
impl RuntimeProvider for WslRuntime {
    fn name(&self) -> &str {
        "wsl"
    }

    async fn run_claude(
        &self,
        prompt: &str,
        working_dir: &Path,
        extra_args: &[String],
    ) -> Result<ProcessOutput> {
        let wsl_dir = Self::to_wsl_path(working_dir);
        let start = std::time::Instant::now();

        let mut claude_cmd = format!(
            "cd {} && {} -p {} --output-format json",
            shell_escape(&wsl_dir),
            shell_escape(&self.claude_bin),
            shell_escape(prompt),
        );
        for arg in extra_args {
            claude_cmd.push(' ');
            claude_cmd.push_str(&shell_escape(arg));
        }

        let output = Command::new("wsl")
            .args(["-e", "bash", "-c", &claude_cmd])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?
            .wait_with_output()
            .await?;

        let elapsed = start.elapsed();

        Ok(ProcessOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            exit_code: output.status.code().unwrap_or(-1),
            wall_time_ms: elapsed.as_millis() as u64,
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

fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
