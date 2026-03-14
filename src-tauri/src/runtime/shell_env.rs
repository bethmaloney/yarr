use anyhow::Result;
use std::collections::HashMap;
use std::time::Duration;

pub const LOCAL_TIMEOUT: Duration = Duration::from_secs(10);
pub const SSH_TIMEOUT: Duration = Duration::from_secs(15);
pub const COMMON_DENYLIST: &[&str] = &["_", "SHLVL", "PWD", "OLDPWD"];
pub const SSH_DENYLIST: &[&str] = &["SSH_AUTH_SOCK", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"];

/// Parse snapshot output between markers, splitting on null bytes.
/// This is extracted as a helper for easy unit testing.
pub fn parse_snapshot_output(
    stdout: &[u8],
    marker: &str,
    denylist: &[&str],
) -> Result<HashMap<String, String>> {
    let marker_bytes = marker.as_bytes();

    // Find first occurrence of marker
    let first = stdout
        .windows(marker_bytes.len())
        .position(|w| w == marker_bytes);
    let first = match first {
        Some(pos) => pos,
        None => anyhow::bail!("first marker not found in output"),
    };

    // Find second occurrence of marker (starting after the first)
    let after_first = first + marker_bytes.len();
    let second = stdout[after_first..]
        .windows(marker_bytes.len())
        .position(|w| w == marker_bytes)
        .map(|pos| pos + after_first);
    let second = match second {
        Some(pos) => pos,
        None => anyhow::bail!("second marker not found in output"),
    };

    // Extract bytes between the two markers
    let between = &stdout[after_first..second];

    if between.is_empty() {
        return Ok(HashMap::new());
    }

    // Split on null bytes
    let mut map = HashMap::new();
    for segment in between.split(|&b| b == 0) {
        let s = String::from_utf8_lossy(segment);
        // Split on first '='
        let Some(eq_pos) = s.find('=') else {
            continue;
        };
        let key = &s[..eq_pos];
        if key.is_empty() {
            continue;
        }
        if denylist.contains(&key) {
            continue;
        }
        let value = &s[eq_pos + 1..];
        map.insert(key.to_string(), value.to_string());
    }

    Ok(map)
}

/// Returns `true` if the string looks like a reasonable Unix shell path.
fn is_valid_shell_path(s: &str) -> bool {
    s.starts_with('/')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/-_.".contains(&b))
}

/// Snapshot the user's shell environment by running an interactive login shell,
/// capturing `env -0` output between UUID markers.
///
/// `shell_override` lets callers specify the shell to use. Pass `Some("$SHELL")`
/// for SSH contexts so the *remote* side resolves `$SHELL` to the remote user's
/// default shell instead of using the local machine's `$SHELL`.
pub async fn snapshot_shell_env<F, Fut>(
    spawn_fn: F,
    timeout: Duration,
    extra_denylist: &[&str],
    shell_override: Option<&str>,
) -> Result<HashMap<String, String>>
where
    F: FnOnce(String) -> Fut,
    Fut: std::future::Future<Output = Result<std::process::Output>>,
{
    let marker = uuid::Uuid::new_v4().to_string().replace('-', "");

    let shell = if let Some(s) = shell_override {
        s.to_string()
    } else {
        let s = std::env::var("SHELL").unwrap_or_default();
        let s = if s.is_empty() || !is_valid_shell_path(&s) {
            "bash".to_string()
        } else {
            s
        };
        let is_fish = std::path::Path::new(&s)
            .file_name()
            .map_or(false, |n| n == "fish");
        if is_fish { "bash".to_string() } else { s }
    };

    let cmd = format!(
        "{shell} -ilc 'echo -n {marker}; env -0; echo -n {marker}'"
    );

    let output = tokio::time::timeout(timeout, spawn_fn(cmd))
        .await
        .map_err(|_| anyhow::anyhow!("shell environment snapshot timed out"))??;

    if !output.status.success() {
        tracing::warn!(
            "shell env snapshot exited with status {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let mut combined_denylist: Vec<&str> = COMMON_DENYLIST.to_vec();
    combined_denylist.extend_from_slice(extra_denylist);

    parse_snapshot_output(&output.stdout, &marker, &combined_denylist)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper to build stdout bytes with markers and null-delimited env vars.
    fn build_env_stdout(marker: &str, vars: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(marker.as_bytes());
        for (i, var) in vars.iter().enumerate() {
            buf.extend_from_slice(var.as_bytes());
            if i < vars.len() - 1 {
                buf.push(0);
            }
        }
        buf.extend_from_slice(marker.as_bytes());
        buf
    }

    #[test]
    fn test_parse_basic() {
        let marker = "MARKER_ABC123";
        let stdout = build_env_stdout(
            marker,
            &["HOME=/home/user", "PATH=/usr/bin", "EDITOR=vim"],
        );

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
        assert_eq!(result.get("PATH").unwrap(), "/usr/bin");
        assert_eq!(result.get("EDITOR").unwrap(), "vim");
    }

    #[test]
    fn test_parse_with_noise_before_and_after_markers() {
        let marker = "MARKER_XYZ789";
        let mut stdout = Vec::new();
        // MOTD / noise before first marker
        stdout.extend_from_slice(b"Welcome to Ubuntu 24.04\nLast login: Mon Jan 1 00:00:00 2024\n");
        // The actual env payload between markers
        stdout.extend_from_slice(marker.as_bytes());
        stdout.extend_from_slice(b"HOME=/home/user");
        stdout.extend_from_slice(marker.as_bytes());
        // Shell prompt after second marker
        stdout.extend_from_slice(b"\n$ ");

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 1);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
    }

    #[test]
    fn test_parse_denylist_filtering() {
        let marker = "MARKER_DENY";
        let stdout = build_env_stdout(
            marker,
            &[
                "HOME=/home/user",
                "_=/usr/bin/env",
                "SHLVL=2",
                "PWD=/tmp",
                "OLDPWD=/home",
                "EDITOR=vim",
            ],
        );

        let result = parse_snapshot_output(&stdout, marker, COMMON_DENYLIST).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
        assert_eq!(result.get("EDITOR").unwrap(), "vim");
        assert!(!result.contains_key("_"));
        assert!(!result.contains_key("SHLVL"));
        assert!(!result.contains_key("PWD"));
        assert!(!result.contains_key("OLDPWD"));
    }

    #[test]
    fn test_parse_extra_denylist() {
        let marker = "MARKER_SSH";
        let stdout = build_env_stdout(
            marker,
            &[
                "HOME=/home/user",
                "SSH_AUTH_SOCK=/tmp/ssh-xxx/agent.123",
                "SSH_CONNECTION=10.0.0.1 12345 10.0.0.2 22",
                "SSH_CLIENT=10.0.0.1 12345 22",
                "SSH_TTY=/dev/pts/0",
                "LANG=en_US.UTF-8",
            ],
        );

        let result = parse_snapshot_output(&stdout, marker, SSH_DENYLIST).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
        assert_eq!(result.get("LANG").unwrap(), "en_US.UTF-8");
        assert!(!result.contains_key("SSH_AUTH_SOCK"));
        assert!(!result.contains_key("SSH_CONNECTION"));
        assert!(!result.contains_key("SSH_CLIENT"));
        assert!(!result.contains_key("SSH_TTY"));
    }

    #[test]
    fn test_parse_value_with_equals_sign() {
        let marker = "MARKER_EQ";
        let stdout = build_env_stdout(
            marker,
            &["GREP_OPTIONS=--color=auto", "JAVA_OPTS=-Xmx=512m -Dfoo=bar"],
        );

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("GREP_OPTIONS").unwrap(), "--color=auto");
        assert_eq!(result.get("JAVA_OPTS").unwrap(), "-Xmx=512m -Dfoo=bar");
    }

    #[test]
    fn test_parse_value_with_newlines() {
        let marker = "MARKER_NL";
        // Build manually: a var whose value contains a literal newline
        let mut stdout = Vec::new();
        stdout.extend_from_slice(marker.as_bytes());
        stdout.extend_from_slice(b"MULTI_LINE=line1\nline2\nline3");
        stdout.push(0);
        stdout.extend_from_slice(b"SIMPLE=yes");
        stdout.extend_from_slice(marker.as_bytes());

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("MULTI_LINE").unwrap(), "line1\nline2\nline3");
        assert_eq!(result.get("SIMPLE").unwrap(), "yes");
    }

    #[test]
    fn test_parse_empty_between_markers() {
        let marker = "MARKER_EMPTY";
        let mut stdout = Vec::new();
        stdout.extend_from_slice(marker.as_bytes());
        stdout.extend_from_slice(marker.as_bytes());

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert!(result.is_empty(), "expected empty HashMap, got {:?}", result);
    }

    #[test]
    fn test_parse_missing_markers() {
        let marker = "MARKER_MISSING";
        let stdout = b"just some random output with no markers at all";

        let result = parse_snapshot_output(stdout, marker, &[]);

        assert!(result.is_err(), "expected error when markers are missing");
    }

    #[test]
    fn test_parse_single_marker() {
        let marker = "MARKER_SINGLE";
        let mut stdout = Vec::new();
        stdout.extend_from_slice(b"some preamble ");
        stdout.extend_from_slice(marker.as_bytes());
        stdout.extend_from_slice(b" trailing content but no second marker");

        let result = parse_snapshot_output(&stdout, marker, &[]);

        assert!(result.is_err(), "expected error when only one marker found");
    }

    #[test]
    fn test_parse_empty_key_skipped() {
        let marker = "MARKER_SKIP";
        let stdout = build_env_stdout(
            marker,
            &[
                "GOOD_KEY=value",
                "=value_with_empty_key",
                "bare_string_no_equals",
                "ANOTHER=ok",
            ],
        );

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("GOOD_KEY").unwrap(), "value");
        assert_eq!(result.get("ANOTHER").unwrap(), "ok");
        assert!(!result.contains_key(""), "empty key should be skipped");
    }

    #[tokio::test]
    async fn test_snapshot_shell_env_integration() {
        // We need a known marker, but snapshot_shell_env generates its own.
        // The mock spawn_fn captures the command, extracts the marker from it,
        // and builds a matching response.
        let spawn_fn = |cmd: String| async move {
            // Verify the command contains expected shell invocation flags
            assert!(
                cmd.contains("-ilc") || cmd.contains("-il -c"),
                "command should contain interactive login shell flags, got: {}",
                cmd
            );

            // Extract the marker from the command — it appears twice in the echo statements
            // The command looks like: bash -ilc 'echo -n <MARKER>; env -0; echo -n <MARKER>'
            // Find the marker between "echo -n " and ";"
            let echo_prefix = "echo -n ";
            let marker_start = cmd.find(echo_prefix).expect("should contain echo -n")
                + echo_prefix.len();
            let marker_end = cmd[marker_start..]
                .find(';')
                .expect("should contain semicolon after marker");
            let marker = &cmd[marker_start..marker_start + marker_end];

            // Build fake env output with that marker
            let mut stdout = Vec::new();
            stdout.extend_from_slice(marker.as_bytes());
            stdout.extend_from_slice(b"HOME=/home/testuser");
            stdout.push(0);
            stdout.extend_from_slice(b"EDITOR=nvim");
            stdout.push(0);
            stdout.extend_from_slice(b"SHLVL=1"); // should be filtered by COMMON_DENYLIST
            stdout.extend_from_slice(marker.as_bytes());

            Ok(std::process::Output {
                status: std::process::ExitStatus::default(),
                stdout,
                stderr: Vec::new(),
            })
        };

        let result = snapshot_shell_env(spawn_fn, LOCAL_TIMEOUT, &[], None).await.unwrap();

        assert_eq!(result.get("HOME").unwrap(), "/home/testuser");
        assert_eq!(result.get("EDITOR").unwrap(), "nvim");
        assert!(
            !result.contains_key("SHLVL"),
            "SHLVL should be filtered by COMMON_DENYLIST"
        );
    }

    #[tokio::test]
    async fn test_snapshot_timeout() {
        let spawn_fn = |_cmd: String| async move {
            // Sleep longer than the timeout
            tokio::time::sleep(Duration::from_secs(5)).await;
            Ok(std::process::Output {
                status: std::process::ExitStatus::default(),
                stdout: Vec::new(),
                stderr: Vec::new(),
            })
        };

        // Use a very short timeout so the test completes quickly
        let result = snapshot_shell_env(spawn_fn, Duration::from_millis(50), &[], None).await;

        assert!(result.is_err(), "expected timeout error");
    }

    #[test]
    fn test_parse_combined_common_and_ssh_denylist() {
        let marker = "MARKER_COMBINED";
        let stdout = build_env_stdout(
            marker,
            &[
                "HOME=/home/user",
                // COMMON_DENYLIST entries
                "_=/usr/bin/env",
                "SHLVL=2",
                "PWD=/tmp",
                "OLDPWD=/home",
                // SSH_DENYLIST entries
                "SSH_AUTH_SOCK=/tmp/ssh-xxx/agent.123",
                "SSH_CONNECTION=10.0.0.1 12345 10.0.0.2 22",
                "SSH_CLIENT=10.0.0.1 12345 22",
                "SSH_TTY=/dev/pts/0",
                // Should survive both denylists
                "EDITOR=vim",
                "LANG=en_US.UTF-8",
            ],
        );

        let mut combined: Vec<&str> = COMMON_DENYLIST.to_vec();
        combined.extend_from_slice(SSH_DENYLIST);

        let result = parse_snapshot_output(&stdout, marker, &combined).unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
        assert_eq!(result.get("EDITOR").unwrap(), "vim");
        assert_eq!(result.get("LANG").unwrap(), "en_US.UTF-8");
        // Verify all COMMON_DENYLIST entries are filtered
        assert!(!result.contains_key("_"));
        assert!(!result.contains_key("SHLVL"));
        assert!(!result.contains_key("PWD"));
        assert!(!result.contains_key("OLDPWD"));
        // Verify all SSH_DENYLIST entries are filtered
        assert!(!result.contains_key("SSH_AUTH_SOCK"));
        assert!(!result.contains_key("SSH_CONNECTION"));
        assert!(!result.contains_key("SSH_CLIENT"));
        assert!(!result.contains_key("SSH_TTY"));
    }

    #[tokio::test]
    async fn test_snapshot_shell_env_non_zero_exit_with_valid_output() {
        // An interactive shell may exit non-zero (e.g., last command in .bashrc
        // fails), but the env output between markers is still valid.
        let spawn_fn = |cmd: String| async move {
            let echo_prefix = "echo -n ";
            let marker_start = cmd.find(echo_prefix).expect("should contain echo -n")
                + echo_prefix.len();
            let marker_end = cmd[marker_start..]
                .find(';')
                .expect("should contain semicolon after marker");
            let marker = &cmd[marker_start..marker_start + marker_end];

            let mut stdout = Vec::new();
            stdout.extend_from_slice(marker.as_bytes());
            stdout.extend_from_slice(b"HOME=/home/testuser");
            stdout.push(0);
            stdout.extend_from_slice(b"LANG=C.UTF-8");
            stdout.extend_from_slice(marker.as_bytes());

            // Simulate non-zero exit via ExitStatus
            // We can't construct a non-zero ExitStatus directly in stable Rust,
            // so we use Command to produce one.
            let status = std::process::Command::new("sh")
                .arg("-c")
                .arg("exit 1")
                .status()
                .expect("should be able to run sh");

            Ok(std::process::Output {
                status,
                stdout,
                stderr: b"bash: some_rc_cmd: command not found\n".to_vec(),
            })
        };

        let result = snapshot_shell_env(spawn_fn, LOCAL_TIMEOUT, &[], None).await.unwrap();

        assert_eq!(result.get("HOME").unwrap(), "/home/testuser");
        assert_eq!(result.get("LANG").unwrap(), "C.UTF-8");
    }

    #[test]
    fn test_parse_value_with_empty_value() {
        let marker = "MARKER_EMPTYVAL";
        let stdout = build_env_stdout(
            marker,
            &["EMPTY_VAR=", "NORMAL=hello", "ALSO_EMPTY="],
        );

        let result = parse_snapshot_output(&stdout, marker, &[]).unwrap();

        assert_eq!(result.len(), 3);
        assert_eq!(
            result.get("EMPTY_VAR").unwrap(),
            "",
            "var with empty value after '=' should parse as empty string"
        );
        assert_eq!(result.get("NORMAL").unwrap(), "hello");
        assert_eq!(
            result.get("ALSO_EMPTY").unwrap(),
            "",
            "another var with empty value should also parse as empty string"
        );
    }

    #[tokio::test]
    async fn test_snapshot_shell_env_with_ssh_extra_denylist() {
        // Passing SSH_DENYLIST as extra_denylist should filter both COMMON_DENYLIST
        // (always applied) and SSH_DENYLIST vars.
        let spawn_fn = |cmd: String| async move {
            let echo_prefix = "echo -n ";
            let marker_start = cmd.find(echo_prefix).expect("should contain echo -n")
                + echo_prefix.len();
            let marker_end = cmd[marker_start..]
                .find(';')
                .expect("should contain semicolon after marker");
            let marker = &cmd[marker_start..marker_start + marker_end];

            let mut stdout = Vec::new();
            stdout.extend_from_slice(marker.as_bytes());
            // Vars that should survive
            stdout.extend_from_slice(b"HOME=/home/user");
            stdout.push(0);
            stdout.extend_from_slice(b"EDITOR=vim");
            stdout.push(0);
            // COMMON_DENYLIST var — should be filtered
            stdout.extend_from_slice(b"SHLVL=3");
            stdout.push(0);
            stdout.extend_from_slice(b"PWD=/home/user");
            stdout.push(0);
            // SSH_DENYLIST var — should be filtered via extra_denylist
            stdout.extend_from_slice(b"SSH_AUTH_SOCK=/tmp/ssh-abc/agent.999");
            stdout.push(0);
            stdout.extend_from_slice(b"SSH_TTY=/dev/pts/1");
            stdout.extend_from_slice(marker.as_bytes());

            Ok(std::process::Output {
                status: std::process::ExitStatus::default(),
                stdout,
                stderr: Vec::new(),
            })
        };

        let result = snapshot_shell_env(spawn_fn, LOCAL_TIMEOUT, SSH_DENYLIST, None)
            .await
            .unwrap();

        assert_eq!(result.len(), 2);
        assert_eq!(result.get("HOME").unwrap(), "/home/user");
        assert_eq!(result.get("EDITOR").unwrap(), "vim");
        // COMMON_DENYLIST vars filtered
        assert!(
            !result.contains_key("SHLVL"),
            "SHLVL should be filtered by COMMON_DENYLIST"
        );
        assert!(
            !result.contains_key("PWD"),
            "PWD should be filtered by COMMON_DENYLIST"
        );
        // SSH_DENYLIST vars filtered via extra_denylist
        assert!(
            !result.contains_key("SSH_AUTH_SOCK"),
            "SSH_AUTH_SOCK should be filtered by SSH_DENYLIST extra_denylist"
        );
        assert!(
            !result.contains_key("SSH_TTY"),
            "SSH_TTY should be filtered by SSH_DENYLIST extra_denylist"
        );
    }
}
