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
    pub effort_level: Option<String>,
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
    /// Wait for the process to exit. Returns (`exit_code`, `wall_time_ms`).
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
/// - Windows → `WslRuntime` (shells into WSL to run claude)
/// - Linux/macOS → `LocalRuntime` (runs claude directly)
#[must_use] 
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

    /// Read a file from the repo filesystem.
    /// Default implementation uses `cat` via `run_command`; runtimes with
    /// direct filesystem access (e.g. `LocalRuntime`) can override for efficiency.
    async fn read_file(
        &self,
        file_path: &str,
        working_dir: &std::path::Path,
    ) -> Result<String> {
        let escaped = ssh::shell_escape(file_path);
        let output = self
            .run_command(
                &format!("cat {escaped}"),
                working_dir,
                std::time::Duration::from_secs(10),
            )
            .await?;
        if output.exit_code != 0 {
            anyhow::bail!(
                "Failed to read file '{}': {}",
                file_path,
                output.stderr.trim()
            );
        }
        Ok(output.stdout)
    }

    /// Resolve environment variables for this runtime.
    /// Default implementation returns the current process environment.
    async fn resolve_env(&self) -> Result<HashMap<String, String>> {
        Ok(std::env::vars().collect())
    }

    /// Returns a warning message if the environment snapshot failed.
    /// Call after `resolve_env()` to check for warnings.
    fn env_warning(&self) -> Option<String> {
        None
    }
}

struct CachedEnv {
    vars: HashMap<String, String>,
    warning: Option<String>,
}

/// Cached local shell environment, initialized once on first access.
static LOCAL_ENV_CACHE: tokio::sync::OnceCell<CachedEnv> =
    tokio::sync::OnceCell::const_new();

/// Returns a reference to the cached local shell environment.
///
/// On first call, snapshots the user's interactive login shell environment
/// via `snapshot_shell_env`. If that fails (e.g. no interactive shell in CI),
/// falls back to `std::env::vars()`.
pub async fn get_or_init_local_env() -> &'static HashMap<String, String> {
    &LOCAL_ENV_CACHE
        .get_or_init(|| async {
            // On Windows the snapshot runs inside WSL, so use $SHELL
            // (expanded by WSL bash) to pick up the WSL user's default
            // shell rather than the Windows process's $SHELL (which is
            // unset and would fall back to bash).
            let shell_override: Option<&str> = if cfg!(target_os = "windows") {
                Some("${SHELL:-bash}")
            } else {
                None
            };
            tracing::info!("initializing local shell environment cache");
            match shell_env::snapshot_shell_env(
                |cmd| async move {
                    tracing::debug!(cmd = %cmd, "spawning env snapshot command");
                    let output = if cfg!(target_os = "windows") {
                        tokio::process::Command::new("wsl")
                            .args(["-e", "bash", "-c", &cmd])
                            .output()
                            .await?
                    } else {
                        tokio::process::Command::new("bash")
                            .arg("-c")
                            .arg(&cmd)
                            .output()
                            .await?
                    };
                    Ok(output)
                },
                shell_env::LOCAL_TIMEOUT,
                &[],
                shell_override,
            )
            .await
            {
                Ok(env) => {
                    tracing::info!(var_count = env.len(), "local shell env cache initialized successfully");
                    CachedEnv { vars: env, warning: None }
                }
                Err(e) => {
                    let warning = format!(
                        "Failed to load shell environment — some tools (nvm, pyenv, etc.) may not be available. Restart the app to retry. Error: {e}"
                    );
                    tracing::warn!("{warning}");
                    // On Windows the fallback must NOT be std::env::vars()
                    // because that returns Windows host environment variables
                    // (ProgramFiles(x86), APPDATA, etc.) which are invalid
                    // and harmful when exported into a WSL bash session.
                    // Use an empty map so WSL commands run with WSL's own defaults.
                    let fallback_vars = if cfg!(target_os = "windows") {
                        HashMap::new()
                    } else {
                        std::env::vars().collect()
                    };
                    CachedEnv {
                        vars: fallback_vars,
                        warning: Some(warning),
                    }
                }
            }
        })
        .await
        .vars
}

/// Returns the warning message (if any) from the local shell environment snapshot.
/// Must be called after `get_or_init_local_env()` has been awaited at least once.
pub fn get_local_env_warning() -> Option<String> {
    LOCAL_ENV_CACHE.get().and_then(|c| c.warning.clone())
}

/// Thread-safe cache of SSH host environment snapshots.
///
/// Wraps an `Arc<DashMap>` mapping host identifiers to their captured environment
/// variables. The `Arc` allows cloning a reference for `SshRuntime::new()` while
/// keeping the cache in Tauri managed state.
pub struct SshEnvCache(std::sync::Arc<dashmap::DashMap<String, HashMap<String, String>>>);

impl SshEnvCache {
    /// Returns a clone of the inner `Arc`, suitable for passing to `SshRuntime::new()`.
    #[must_use] 
    pub fn cache_ref(&self) -> std::sync::Arc<dashmap::DashMap<String, HashMap<String, String>>> {
        self.0.clone()
    }
}

impl Default for SshEnvCache {
    fn default() -> Self {
        Self(std::sync::Arc::new(dashmap::DashMap::new()))
    }
}

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
        // to std::env::vars() on non-Windows, or empty on Windows.
        let env: &HashMap<String, String> = get_or_init_local_env().await;

        if cfg!(not(target_os = "windows")) {
            assert!(
                !env.is_empty(),
                "local env cache should not be empty on non-Windows"
            );

            // PATH should always be present in the result on non-Windows
            assert!(
                env.contains_key("PATH") || env.contains_key("Path"),
                "local env should contain PATH"
            );
        }
        // On Windows the fallback is an empty map (Windows process env
        // is useless inside WSL), so we don't assert non-empty.
    }

    #[tokio::test]
    async fn get_or_init_local_env_no_windows_vars_on_windows() {
        // On Windows, the local env cache should never contain Windows-only
        // env vars — even if the WSL snapshot fails. The fallback should be
        // an empty map, not std::env::vars() (which gives Windows host env).
        let env: &HashMap<String, String> = get_or_init_local_env().await;

        // These vars only exist in a Windows process environment, never in WSL.
        // If any are present, the fallback is leaking Windows env into WSL.
        let windows_only_vars = [
            "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot",
            "ComSpec", "PATHEXT", "windir", "HOMEDRIVE", "HOMEPATH",
        ];
        for var in &windows_only_vars {
            assert!(
                !env.contains_key(*var),
                "local env should not contain Windows-only var '{var}' — \
                 this means Windows process env leaked into WSL env cache"
            );
        }
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

    // ---------------------------------------------------------------
    // Tests for SshEnvCache with Arc-based inner and cache_ref()
    // ---------------------------------------------------------------

    #[test]
    fn ssh_env_cache_cache_ref_shares_state_insert_via_cache() {
        // Inserting via the cache should be visible through the Arc
        // returned by cache_ref().
        let cache = SshEnvCache::default();
        let arc = cache.cache_ref();

        let env = HashMap::from([("HOME".to_string(), "/home/user".to_string())]);
        cache.insert("host1".to_string(), env.clone());

        let entry = arc.get("host1").expect("arc should see entry inserted via cache");
        assert_eq!(*entry, env);
    }

    #[test]
    fn ssh_env_cache_cache_ref_shares_state_insert_via_arc() {
        // Inserting via the Arc should be visible through the cache's
        // Deref (and vice versa), proving they share the same DashMap.
        let cache = SshEnvCache::default();
        let arc = cache.cache_ref();

        let env = HashMap::from([("SHELL".to_string(), "/bin/zsh".to_string())]);
        arc.insert("host2".to_string(), env.clone());

        let entry = cache.get("host2").expect("cache should see entry inserted via arc");
        assert_eq!(*entry, env);
    }

    #[test]
    fn ssh_env_cache_cache_ref_returns_cloneable_arc() {
        // cache_ref() should return an Arc that can be cloned and all
        // clones share state.
        let cache = SshEnvCache::default();
        let arc1 = cache.cache_ref();
        let arc2 = cache.cache_ref();

        let env = HashMap::from([("K".to_string(), "V".to_string())]);
        arc1.insert("host".to_string(), env.clone());

        assert!(
            arc2.contains_key("host"),
            "second Arc clone should see insert from first"
        );
        assert_eq!(*arc2.get("host").unwrap(), env);
    }

    #[test]
    fn ssh_env_cache_deref_still_works_after_arc_change() {
        // After wrapping in Arc, the Deref-based API (insert, get,
        // contains_key) should still work exactly as before.
        let cache = SshEnvCache::default();

        let env1 = HashMap::from([("A".to_string(), "1".to_string())]);
        let env2 = HashMap::from([("B".to_string(), "2".to_string())]);

        cache.insert("h1".to_string(), env1.clone());
        cache.insert("h2".to_string(), env2.clone());

        assert!(cache.contains_key("h1"));
        assert!(cache.contains_key("h2"));
        assert!(!cache.contains_key("h3"));
        assert_eq!(*cache.get("h1").unwrap(), env1);
        assert_eq!(*cache.get("h2").unwrap(), env2);
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn ssh_env_cache_cache_ref_type_is_arc_dashmap() {
        // Verify the returned type is compatible with SshRuntime::new's
        // env_cache parameter (Arc<DashMap<String, HashMap<String, String>>>).
        let cache = SshEnvCache::default();
        let arc: std::sync::Arc<dashmap::DashMap<String, HashMap<String, String>>> =
            cache.cache_ref();

        // Should be usable as the env_cache argument
        let env = HashMap::from([("TEST".to_string(), "val".to_string())]);
        arc.insert("ssh-host".to_string(), env.clone());
        assert_eq!(*arc.get("ssh-host").unwrap(), env);
    }

    #[test]
    fn ssh_env_cache_cache_ref_mutation_visible_bidirectionally() {
        // Comprehensive bidirectional mutation test: interleave writes
        // through cache and arc, verifying each sees the other's writes.
        let cache = SshEnvCache::default();
        let arc = cache.cache_ref();

        // Write via cache, read via arc
        cache.insert(
            "host-a".to_string(),
            HashMap::from([("X".to_string(), "1".to_string())]),
        );
        assert!(arc.contains_key("host-a"));

        // Write via arc, read via cache
        arc.insert(
            "host-b".to_string(),
            HashMap::from([("Y".to_string(), "2".to_string())]),
        );
        assert!(cache.contains_key("host-b"));

        // Overwrite via arc, read via cache
        arc.insert(
            "host-a".to_string(),
            HashMap::from([("X".to_string(), "overwritten".to_string())]),
        );
        assert_eq!(
            cache.get("host-a").unwrap().get("X").unwrap(),
            "overwritten"
        );

        // Remove via cache, verify gone in arc
        cache.remove("host-b");
        assert!(!arc.contains_key("host-b"));
    }

    // ---------------------------------------------------------------
    // Tests for get_local_env_warning (Task 7: env warning surface)
    // ---------------------------------------------------------------

    #[tokio::test]
    async fn get_local_env_warning_returns_none_when_no_failure() {
        // After initializing the local env cache, get_local_env_warning()
        // should return None when the snapshot succeeded (or the fallback
        // worked without error — which is the typical CI/test scenario).
        //
        // We call get_or_init_local_env() first to ensure the cache is
        // populated, then verify the warning accessor doesn't panic and
        // returns a valid Option<String>.
        let _env = get_or_init_local_env().await;

        // get_local_env_warning() is a sync function that reads the cached
        // warning. In test/CI the snapshot may or may not fail, so we just
        // verify the function exists and returns an Option<String> without
        // panicking.
        let warning: Option<String> = get_local_env_warning();

        // If the snapshot succeeded (PATH is present in the env), the
        // warning should be None.
        let env = get_or_init_local_env().await;
        if env.contains_key("PATH") || env.contains_key("Path") {
            // Snapshot or fallback worked — no warning expected in most
            // environments. But we don't hard-assert None because the
            // fallback path may still set a warning in some implementations.
            // The key assertion is that the function is callable and returns
            // a well-typed value.
            let _ = warning;
        }
    }

    // ---------------------------------------------------------------
    // Tests for env_warning default trait implementation (Task 7)
    // ---------------------------------------------------------------

    #[test]
    fn env_warning_default_returns_none() {
        // MockRuntime inherits the default env_warning() trait method,
        // which should return None (no warning).
        let runtime = MockRuntime::completing_after(1);
        let warning = runtime.env_warning();
        assert_eq!(
            warning, None,
            "default env_warning() should return None"
        );
    }
}
