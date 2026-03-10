mod local;
mod mock;
pub mod ssh;
mod wsl;

pub use local::LocalRuntime;
pub use mock::MockRuntime;
pub use ssh::{shell_escape as ssh_shell_escape, ssh_command, ssh_command_raw, SshRuntime};
pub use wsl::WslRuntime;

use anyhow::Result;
use tokio::sync::mpsc;

use crate::output::StreamEvent;

/// Configuration for a single `claude -p` invocation
#[derive(Debug, Clone)]
pub struct ClaudeInvocation {
    pub prompt: String,
    pub working_dir: std::path::PathBuf,
    pub model: Option<String>,
    pub extra_args: Vec<String>,
    pub env_vars: std::collections::HashMap<String, String>,
}

/// Trait for aborting a running process. Implementations can do
/// platform-specific cleanup (e.g. killing WSL child processes).
pub trait AbortHandle: Send + Sync {
    fn abort(&self);
}

/// Simple abort handle that just aborts the tokio task (used by LocalRuntime/MockRuntime)
pub struct TaskAbortHandle(pub tokio::task::AbortHandle);

impl AbortHandle for TaskAbortHandle {
    fn abort(&self) {
        self.0.abort();
    }
}

/// A handle to a running Claude process.
/// Provides a channel of streaming events and a way to wait for completion.
pub struct RunningProcess {
    /// Receive stream-json events as they arrive
    pub events: mpsc::Receiver<StreamEvent>,
    /// Wait for the process to exit. Returns (exit_code, wall_time_ms).
    pub completion: tokio::task::JoinHandle<Result<ProcessExit>>,
    /// Abort handle that kills the child process and cleans up
    pub abort_handle: Box<dyn AbortHandle>,
}

#[derive(Debug, Clone)]
pub struct ProcessExit {
    pub exit_code: i32,
    pub wall_time_ms: u64,
    pub stderr: String,
}

/// Returns the appropriate runtime for the current platform:
/// - Windows → WslRuntime (shells into WSL to run claude)
/// - Linux/macOS → LocalRuntime (runs claude directly)
pub fn default_runtime() -> Box<dyn RuntimeProvider> {
    if cfg!(target_os = "windows") {
        Box::new(WslRuntime::new())
    } else {
        Box::new(LocalRuntime::new())
    }
}

/// Output from running an arbitrary shell command
#[derive(Debug, Clone)]
pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Abstraction over execution environments.
/// Implement this trait to add new runtimes (SSH, macOS local, etc.)
#[async_trait::async_trait]
pub trait RuntimeProvider: Send + Sync {
    /// Human-readable name for this runtime
    fn name(&self) -> &str;

    /// Spawn `claude -p` and return a handle for streaming events.
    /// The prompt is piped via stdin to avoid argument length limits.
    async fn spawn_claude(&self, invocation: &ClaudeInvocation) -> Result<RunningProcess>;

    /// Check if the runtime is available and claude is installed
    async fn health_check(&self) -> Result<()>;

    /// Run an arbitrary shell command and return its output
    async fn run_command(
        &self,
        command: &str,
        working_dir: &std::path::Path,
        timeout: std::time::Duration,
    ) -> Result<CommandOutput>;
}
