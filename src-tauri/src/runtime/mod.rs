mod local;
mod mock;
pub mod shell_env;
pub mod ssh;
mod wsl;

pub use local::LocalRuntime;
pub use mock::MockRuntime;
pub use ssh::{shell_escape as ssh_shell_escape, ssh_command, ssh_command_raw, SshRuntime};
pub use wsl::WslRuntime;

use anyhow::Result;
use std::collections::HashMap;
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

    /// Resolve environment variables for this runtime.
    /// Default implementation returns the current process environment.
    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        Ok(std::env::vars().collect())
    }
}

/// Cached local shell environment, initialized once on first access.
static LOCAL_ENV_CACHE: tokio::sync::OnceCell<HashMap<String, String>> =
    tokio::sync::OnceCell::const_new();

/// Returns a reference to the cached local shell environment.
///
/// On first call, snapshots the user's interactive login shell environment
/// via `snapshot_shell_env`. If that fails (e.g. no interactive shell in CI),
/// falls back to `std::env::vars()`.
pub async fn get_or_init_local_env() -> &'static HashMap<String, String> {
    LOCAL_ENV_CACHE
        .get_or_init(|| async {
            match shell_env::snapshot_shell_env(
                |cmd| async move {
                    let output = tokio::process::Command::new("bash")
                        .arg("-c")
                        .arg(&cmd)
                        .output()
                        .await?;
                    Ok(output)
                },
                shell_env::LOCAL_TIMEOUT,
                &[],
            )
            .await
            {
                Ok(env) => env,
                Err(e) => {
                    tracing::warn!(
                        "failed to snapshot local shell environment, falling back to process env: {e}"
                    );
                    std::env::vars().collect()
                }
            }
        })
        .await
}

/// Thread-safe cache of SSH host environment snapshots.
///
/// Wraps a `DashMap` mapping host identifiers to their captured environment
/// variables. Implements `Deref` for ergonomic access to `DashMap` methods.
#[derive(Default)]
pub struct SshEnvCache(dashmap::DashMap<String, HashMap<String, String>>);

impl std::ops::Deref for SshEnvCache {
    type Target = dashmap::DashMap<String, HashMap<String, String>>;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // ---------------------------------------------------------------
    // Tests for SshEnvCache newtype (wraps DashMap<String, HashMap<String, String>>)
    // ---------------------------------------------------------------

    #[test]
    fn ssh_env_cache_insert_and_get() {
        let cache = SshEnvCache::default();
        let mut env = HashMap::new();
        env.insert("HOME".to_string(), "/home/user".to_string());
        env.insert("PATH".to_string(), "/usr/bin".to_string());

        cache.insert("host1".to_string(), env.clone());

        let entry = cache.get("host1").expect("should find host1");
        assert_eq!(*entry, env);
    }

    #[test]
    fn ssh_env_cache_contains_key() {
        let cache = SshEnvCache::default();
        assert!(
            !cache.contains_key("missing"),
            "empty cache should not contain any key"
        );

        cache.insert(
            "host-a".to_string(),
            HashMap::from([("K".to_string(), "V".to_string())]),
        );
        assert!(cache.contains_key("host-a"));
        assert!(!cache.contains_key("host-b"));
    }

    #[test]
    fn ssh_env_cache_multiple_hosts() {
        let cache = SshEnvCache::default();

        let env1 = HashMap::from([("HOME".to_string(), "/home/alice".to_string())]);
        let env2 = HashMap::from([("HOME".to_string(), "/home/bob".to_string())]);

        cache.insert("alice-host".to_string(), env1.clone());
        cache.insert("bob-host".to_string(), env2.clone());

        assert_eq!(*cache.get("alice-host").unwrap(), env1);
        assert_eq!(*cache.get("bob-host").unwrap(), env2);
    }

    #[test]
    fn ssh_env_cache_overwrite() {
        let cache = SshEnvCache::default();

        let env_old = HashMap::from([("VER".to_string(), "1".to_string())]);
        let env_new = HashMap::from([("VER".to_string(), "2".to_string())]);

        cache.insert("host".to_string(), env_old);
        cache.insert("host".to_string(), env_new.clone());

        assert_eq!(*cache.get("host").unwrap(), env_new);
    }

    // ---------------------------------------------------------------
    // Tests for resolve_env default trait implementation
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn resolve_env_default_returns_process_env() {
        // MockRuntime inherits the default resolve_env implementation,
        // which should return the current process environment variables.
        let runtime = MockRuntime::completing_after(1);
        let env = runtime.resolve_env().await.expect("resolve_env should succeed");

        // The current process must have PATH set (on all platforms)
        assert!(
            env.contains_key("PATH") || env.contains_key("Path"),
            "resolved env should contain PATH, got keys: {:?}",
            env.keys().take(10).collect::<Vec<_>>()
        );

        // Verify it matches the actual process env for a known variable
        if let Ok(expected_home) = std::env::var("HOME") {
            assert_eq!(
                env.get("HOME").map(|s| s.as_str()),
                Some(expected_home.as_str()),
                "HOME should match std::env::var"
            );
        }
    }

    #[tokio::test]
    async fn resolve_env_returns_non_empty_map() {
        let runtime = MockRuntime::completing_after(1);
        let env = runtime.resolve_env().await.expect("resolve_env should succeed");

        assert!(
            !env.is_empty(),
            "resolved env should not be empty — the process always has some env vars"
        );
    }

    // ---------------------------------------------------------------
    // Tests for get_or_init_local_env
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn get_or_init_local_env_returns_env_vars() {
        // get_or_init_local_env should return a reference to a HashMap
        // with environment variables. Even if snapshot_shell_env fails
        // (e.g. in CI with no interactive shell), it should fall back
        // to std::env::vars().
        let env: &HashMap<String, String> = get_or_init_local_env().await;

        assert!(
            !env.is_empty(),
            "local env cache should not be empty"
        );

        // PATH should always be present in the result
        assert!(
            env.contains_key("PATH") || env.contains_key("Path"),
            "local env should contain PATH"
        );
    }

    #[tokio::test]
    async fn get_or_init_local_env_is_consistent() {
        // Calling get_or_init_local_env multiple times should return
        // the same cached result (OnceCell semantics). Since it returns
        // a reference from a static OnceCell, both pointers should be
        // identical.
        let env1: &HashMap<String, String> = get_or_init_local_env().await;
        let env2: &HashMap<String, String> = get_or_init_local_env().await;

        assert!(
            std::ptr::eq(env1, env2),
            "repeated calls should return the same pointer (OnceCell caching)"
        );
    }
}
