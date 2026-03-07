use tokio::process::Command;

/// Shell-escapes a string by wrapping in single quotes and escaping embedded single quotes.
pub fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Builds an SSH command for executing a remote command on the given host.
///
/// - On Linux/macOS: `ssh <options> <host> <remote_cmd>`
/// - On Windows: `wsl -e bash -lc "ssh <options> <host> <remote_cmd>"`
///
/// SSH options include `-o BatchMode=yes -o StrictHostKeyChecking=accept-new`
/// for non-interactive use.
///
/// `remote_cmd` is passed directly to SSH which forwards it to the remote shell.
/// The caller is responsible for properly escaping `remote_cmd` contents
/// (e.g. using `shell_escape()` for individual arguments within the command).
pub fn ssh_command(host: &str, remote_cmd: &str) -> Command {
    if cfg!(target_os = "windows") {
        let ssh_str = format!(
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new {} {}",
            shell_escape(host),
            remote_cmd
        );
        let mut cmd = Command::new("wsl");
        cmd.arg("-e").arg("bash").arg("-lc").arg(ssh_str);
        cmd
    } else {
        let mut cmd = Command::new("ssh");
        cmd.arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("StrictHostKeyChecking=accept-new")
            .arg(host)
            .arg(remote_cmd);
        cmd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── shell_escape tests ──────────────────────────────────────────

    #[test]
    fn shell_escape_simple_string() {
        assert_eq!(shell_escape("hello"), "'hello'");
    }

    #[test]
    fn shell_escape_string_with_spaces() {
        assert_eq!(shell_escape("hello world"), "'hello world'");
    }

    #[test]
    fn shell_escape_string_with_single_quotes() {
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
    }

    #[test]
    fn shell_escape_string_with_double_quotes() {
        assert_eq!(shell_escape(r#"say "hi""#), r#"'say "hi"'"#);
    }

    #[test]
    fn shell_escape_string_with_special_shell_chars() {
        assert_eq!(shell_escape("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn shell_escape_empty_string() {
        assert_eq!(shell_escape(""), "''");
    }

    #[test]
    fn shell_escape_string_with_backslashes() {
        assert_eq!(shell_escape(r"a\b"), r"'a\b'");
    }

    // ── ssh_command tests ───────────────────────────────────────────

    #[test]
    fn ssh_command_creates_command_with_ssh_program() {
        let cmd = ssh_command("myhost", "ls");
        let std_cmd = cmd.as_std();

        if cfg!(target_os = "windows") {
            assert_eq!(
                std_cmd.get_program(),
                "wsl",
                "on Windows the outer program should be wsl"
            );
        } else {
            assert_eq!(
                std_cmd.get_program(),
                "ssh",
                "on Linux/macOS the program should be ssh"
            );
        }
    }

    #[test]
    fn ssh_command_includes_host_in_args() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("myhost")),
            "expected 'myhost' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_remote_command_in_args() {
        let cmd = ssh_command("myhost", "ls -la");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("ls -la")),
            "expected 'ls -la' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_batch_mode_option() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            all_args.contains("BatchMode=yes"),
            "expected 'BatchMode=yes' in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_includes_strict_host_key_checking_option() {
        let cmd = ssh_command("myhost", "ls");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        let all_args = args_str.join(" ");
        assert!(
            all_args.contains("StrictHostKeyChecking=accept-new"),
            "expected 'StrictHostKeyChecking=accept-new' in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_with_user_at_host() {
        let cmd = ssh_command("beth@server", "whoami");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("beth@server")),
            "expected 'beth@server' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[test]
    fn ssh_command_remote_cmd_with_spaces() {
        let cmd = ssh_command("host", "cat /etc/hostname");
        let args: Vec<&std::ffi::OsStr> = cmd.as_std().get_args().collect();

        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            args_str.iter().any(|a| a.contains("cat /etc/hostname")),
            "expected 'cat /etc/hostname' somewhere in args, got: {:?}",
            args_str
        );
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn ssh_command_on_unix_does_not_use_wsl() {
        let cmd = ssh_command("myhost", "ls");
        let std_cmd = cmd.as_std();

        assert_eq!(
            std_cmd.get_program(),
            "ssh",
            "on Unix the program should be ssh, not wsl"
        );

        let args: Vec<&std::ffi::OsStr> = std_cmd.get_args().collect();
        let args_str: Vec<&str> = args.iter().filter_map(|a| a.to_str()).collect();
        assert!(
            !args_str.iter().any(|a| *a == "wsl"),
            "on Unix, 'wsl' should not appear in args: {:?}",
            args_str
        );
    }
}
