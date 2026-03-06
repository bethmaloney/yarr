mod mock;
mod wsl;

pub use mock::MockRuntime;
pub use wsl::WslRuntime;

use anyhow::Result;
use std::path::Path;

/// Output captured from a single `claude -p` invocation
#[derive(Debug, Clone)]
pub struct ProcessOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub wall_time_ms: u64,
}

/// Abstraction over execution environments.
/// Implement this trait to add new runtimes (SSH, macOS local, etc.)
#[async_trait::async_trait]
pub trait RuntimeProvider: Send + Sync {
    /// Human-readable name for this runtime
    fn name(&self) -> &str;

    /// Execute `claude -p` with the given prompt in the given working directory.
    async fn run_claude(
        &self,
        prompt: &str,
        working_dir: &Path,
        extra_args: &[String],
    ) -> Result<ProcessOutput>;

    /// Check if the runtime is available and claude is installed
    async fn health_check(&self) -> Result<()>;
}
