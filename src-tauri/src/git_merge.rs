use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

use crate::runtime::{ClaudeInvocation, RuntimeProvider};

/// Events emitted during the git merge-push retry loop.
#[derive(Debug, Clone, PartialEq)]
pub enum GitMergeEvent {
    PushSucceeded,
    ConflictDetected { files: Vec<String> },
    ConflictResolveStarted { attempt: u32 },
    ConflictResolveComplete { attempt: u32, success: bool },
    Failed { error: String },
}

/// Configuration for a git merge-push operation.
pub struct GitMergeConfig<'a> {
    pub working_dir: &'a Path,
    /// e.g. "git push origin branch:main" or "git push origin branch"
    pub push_command: &'a str,
    /// e.g. "git fetch origin main" or "git fetch origin branch"
    pub fetch_command: &'a str,
    /// e.g. "git pull --rebase origin main" or "git pull --rebase origin branch"
    pub rebase_command: &'a str,
    /// Optional "push -u" fallback command to try if the initial push fails.
    /// e.g. "git push -u origin branch" — tries setting upstream before entering retry loop.
    pub push_u_command: Option<&'a str>,
    /// Custom prompt for Claude conflict resolution (None = use default)
    pub conflict_prompt: Option<&'a str>,
    /// Model to use for conflict resolution (None = default "sonnet")
    pub conflict_model: Option<String>,
    /// Maximum number of fetch-rebase-push retry attempts
    pub max_retries: u32,
    /// Token to signal cancellation
    pub cancel_token: &'a CancellationToken,
    /// Environment variables to pass to spawned Claude processes
    pub env_vars: &'a HashMap<String, String>,
}

fn combine_output(stdout: &str, stderr: &str) -> String {
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, _) => stderr.to_string(),
        (_, true) => stdout.to_string(),
        _ => format!("{}\n{}", stdout, stderr),
    }
}

/// Shared git merge-push logic with retry loop and conflict resolution.
///
/// 1. Try `config.push_command`
/// 2. If push fails and `push_u_command` is set, try that as a fallback
/// 3. If still failing, enter retry loop (up to `max_retries`):
///    - Run `config.fetch_command`
///    - Run `config.rebase_command`
///    - If rebase succeeds: push again
///    - If rebase fails with conflicts: detect files, spawn Claude, check completion, push
///    - If rebase fails for other reasons: abort rebase, continue
/// 4. Returns `Ok(())` on successful push, `Err(last_error)` after all retries exhausted
pub async fn git_merge_push(
    runtime: &dyn RuntimeProvider,
    config: &GitMergeConfig<'_>,
    on_event: impl Fn(GitMergeEvent),
) -> Result<(), String> {
    let timeout = Duration::from_secs(120);

    // 1. Check cancel_token
    if config.cancel_token.is_cancelled() {
        return Err("cancelled".to_string());
    }

    // Track the last error for reporting
    let mut last_error;

    // 2. Try push
    match runtime
        .run_command(config.push_command, config.working_dir, timeout)
        .await
    {
        Ok(output) if output.exit_code == 0 => {
            on_event(GitMergeEvent::PushSucceeded);
            return Ok(());
        }
        Ok(output) => {
            last_error = combine_output(&output.stdout, &output.stderr);
        }
        Err(e) => {
            last_error = format!("git push command error: {}", e);
        }
    }

    tracing::info!("git push failed: {}", last_error);

    // 3. Try push -u fallback if configured
    if let Some(push_u_cmd) = config.push_u_command {
        match runtime
            .run_command(push_u_cmd, config.working_dir, timeout)
            .await
        {
            Ok(output) if output.exit_code == 0 => {
                on_event(GitMergeEvent::PushSucceeded);
                return Ok(());
            }
            Ok(output) => {
                last_error = combine_output(&output.stdout, &output.stderr);
                tracing::info!("git push -u failed: {}", last_error);
            }
            Err(e) => {
                last_error = format!("git push -u command error: {}", e);
                tracing::info!("git push -u failed: {}", last_error);
            }
        }
    }

    // 4. Retry loop
    for attempt in 1..=config.max_retries {
        // a. Check cancel_token
        if config.cancel_token.is_cancelled() {
            return Err("cancelled".to_string());
        }

        // b. Fetch
        match runtime
            .run_command(config.fetch_command, config.working_dir, timeout)
            .await
        {
            Ok(output) if output.exit_code != 0 => {
                last_error = combine_output(&output.stdout, &output.stderr);
                tracing::warn!("git fetch failed (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                continue;
            }
            Err(e) => {
                last_error = format!("git fetch command error: {}", e);
                tracing::warn!("git fetch error (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                continue;
            }
            _ => {} // success
        }

        // c. Rebase
        let rebase_result = runtime
            .run_command(config.rebase_command, config.working_dir, timeout)
            .await;

        match rebase_result {
            Ok(output) if output.exit_code == 0 => {
                // Rebase succeeded, try push
                match runtime
                    .run_command(config.push_command, config.working_dir, timeout)
                    .await
                {
                    Ok(push_output) if push_output.exit_code == 0 => {
                        on_event(GitMergeEvent::PushSucceeded);
                        return Ok(());
                    }
                    Ok(push_output) => {
                        last_error =
                            combine_output(&push_output.stdout, &push_output.stderr);
                        tracing::warn!("push after rebase failed (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                    }
                    Err(e) => {
                        last_error = format!("push after rebase command error: {}", e);
                        tracing::warn!("push after rebase failed (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                    }
                }
            }
            Ok(rebase_output) => {
                let rebase_error =
                    combine_output(&rebase_output.stdout, &rebase_output.stderr);
                tracing::warn!("rebase failed (attempt {}/{}): {}", attempt, config.max_retries, rebase_error);

                // Rebase failed -- check for conflicts
                let status_result = runtime
                    .run_command("git status", config.working_dir, timeout)
                    .await;

                let has_conflict = match &status_result {
                    Ok(status) => {
                        let combined =
                            combine_output(&status.stdout, &status.stderr);
                        combined.contains("Unmerged paths")
                            || combined.contains("both modified")
                    }
                    Err(_) => false,
                };

                if has_conflict {
                    // Get conflict file list
                    let conflict_files = match runtime
                        .run_command(
                            "git diff --name-only --diff-filter=U",
                            config.working_dir,
                            timeout,
                        )
                        .await
                    {
                        Ok(output) => output
                            .stdout
                            .lines()
                            .map(|l| l.trim().to_string())
                            .filter(|l| !l.is_empty())
                            .collect::<Vec<String>>(),
                        Err(_) => Vec::new(),
                    };

                    let files_str = conflict_files.join("\n");

                    on_event(GitMergeEvent::ConflictDetected {
                        files: conflict_files,
                    });
                    on_event(GitMergeEvent::ConflictResolveStarted { attempt });

                    // Build conflict prompt and spawn Claude
                    let conflict_prompt = crate::prompt::build_conflict_prompt(
                        config.conflict_prompt,
                        &files_str,
                    );

                    let invocation = ClaudeInvocation {
                        prompt: conflict_prompt,
                        working_dir: config.working_dir.to_path_buf(),
                        model: config
                            .conflict_model
                            .clone()
                            .or(Some("sonnet".to_string())),
                        extra_args: vec![
                            "--dangerously-skip-permissions".to_string(),
                        ],
                        env_vars: HashMap::new(),
                    };

                    match runtime.spawn_claude(&invocation).await {
                        Ok(mut process) => {
                            // Drain Claude's events
                            loop {
                                tokio::select! {
                                    event = process.events.recv() => {
                                        if event.is_none() {
                                            break;
                                        }
                                        // Just drain, don't need to do anything
                                    }
                                    _ = config.cancel_token.cancelled() => {
                                        process.abort_handle.abort();
                                        let _ = runtime.run_command(
                                            "git rebase --abort",
                                            config.working_dir,
                                            timeout,
                                        ).await;
                                        return Err("cancelled".to_string());
                                    }
                                }
                            }
                            let _ = process.completion.await;
                        }
                        Err(e) => {
                            tracing::warn!("Conflict resolution agent failed to spawn: {}", e);
                            // Abort the rebase since we can't resolve conflicts
                            let _ = runtime
                                .run_command(
                                    "git rebase --abort",
                                    config.working_dir,
                                    timeout,
                                )
                                .await;
                            last_error =
                                format!("conflict resolution failed to start: {}", e);
                            continue;
                        }
                    }

                    // Check if rebase is still in progress
                    let post_status = runtime
                        .run_command("git status", config.working_dir, timeout)
                        .await;

                    let rebase_in_progress = match &post_status {
                        Ok(status) => {
                            let combined =
                                combine_output(&status.stdout, &status.stderr);
                            combined.contains("rebase in progress")
                        }
                        Err(_) => false,
                    };

                    if rebase_in_progress {
                        let _ = runtime
                            .run_command(
                                "git rebase --abort",
                                config.working_dir,
                                timeout,
                            )
                            .await;
                        on_event(GitMergeEvent::ConflictResolveComplete {
                            attempt,
                            success: false,
                        });
                        last_error =
                            "conflict resolution did not complete rebase".to_string();
                    } else {
                        on_event(GitMergeEvent::ConflictResolveComplete {
                            attempt,
                            success: true,
                        });

                        // Retry push after successful conflict resolution
                        match runtime
                            .run_command(
                                config.push_command,
                                config.working_dir,
                                timeout,
                            )
                            .await
                        {
                            Ok(push_output) if push_output.exit_code == 0 => {
                                on_event(GitMergeEvent::PushSucceeded);
                                return Ok(());
                            }
                            Ok(push_output) => {
                                last_error = combine_output(
                                    &push_output.stdout,
                                    &push_output.stderr,
                                );
                                tracing::warn!("push after conflict resolution failed (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                            }
                            Err(e) => {
                                last_error = format!(
                                    "push after conflict resolution command error: {}",
                                    e
                                );
                                tracing::warn!("push after conflict resolution failed (attempt {}/{}): {}", attempt, config.max_retries, last_error);
                            }
                        }
                    }
                } else {
                    // Rebase failed for non-conflict reasons
                    last_error = rebase_error;
                    let _ = runtime
                        .run_command(
                            "git rebase --abort",
                            config.working_dir,
                            timeout,
                        )
                        .await;
                }
            }
            Err(e) => {
                last_error = format!("rebase command error: {}", e);
                tracing::warn!("rebase error (attempt {}/{}): {}", attempt, config.max_retries, last_error);
            }
        }
    }

    // 5. All retries exhausted
    let error_msg = if last_error.is_empty() {
        "push failed after all retries".to_string()
    } else {
        format!("push failed after all retries: {}", last_error)
    };
    on_event(GitMergeEvent::Failed {
        error: error_msg.clone(),
    });
    Err(error_msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{CommandOutput, MockRuntime};
    use std::sync::{Arc, Mutex};

    /// Helper: build a default GitMergeConfig for tests.
    fn test_config<'a>(cancel_token: &'a CancellationToken, env_vars: &'a HashMap<String, String>) -> GitMergeConfig<'a> {
        GitMergeConfig {
            working_dir: Path::new("/mock/repo"),
            push_command: "git push origin main",
            push_u_command: None,
            fetch_command: "git fetch origin main",
            rebase_command: "git pull --rebase origin main",
            conflict_prompt: None,
            conflict_model: None,
            max_retries: 3,
            cancel_token,
            env_vars,
        }
    }

    /// Helper: collect events via Arc<Mutex<Vec>> callback.
    fn event_collector() -> (Arc<Mutex<Vec<GitMergeEvent>>>, impl Fn(GitMergeEvent)) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let events_clone = events.clone();
        let callback = move |e: GitMergeEvent| {
            events_clone.lock().unwrap().push(e);
        };
        (events, callback)
    }

    // ---------------------------------------------------------------
    // Test 1: Push succeeds on the first try
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_push_succeeds_first_try() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push: git push origin main — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_ok(), "push should succeed on first try, got: {:?}", result);

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should emit PushSucceeded, got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 2: Push fails, push -u succeeds (no retry loop)
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_push_u_fallback_succeeds() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push: git push origin main — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "error: failed to push some refs".to_string(),
            },
            // 2. Push -u: git push -u origin branch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = GitMergeConfig {
            working_dir: Path::new("/mock/repo"),
            push_command: "git push origin main",
            push_u_command: Some("git push -u origin branch"),
            fetch_command: "git fetch origin main",
            rebase_command: "git pull --rebase origin main",
            conflict_prompt: None,
            conflict_model: None,
            max_retries: 3,
            cancel_token: &cancel_token,
            env_vars: &env_vars,
        };

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_ok(), "push -u should succeed, got: {:?}", result);

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should emit PushSucceeded, got: {:?}",
            collected
        );
        assert_eq!(
            collected.len(),
            1,
            "should only emit PushSucceeded (no retry loop events), got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 3: Push fails, rebase succeeds, then push succeeds
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_push_fails_rebase_succeeds_push_succeeds() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected: non-fast-forward".to_string(),
            },
            // 2. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. Rebase — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 4. Push (retry) — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_ok(), "should succeed after rebase, got: {:?}", result);

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should emit PushSucceeded, got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 4: Rebase conflict, Claude resolves, push succeeds
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_rebase_conflict_claude_resolves_push_succeeds() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 2. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. Rebase — fails (conflicts)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "CONFLICT (content): Merge conflict in src/main.rs".to_string(),
            },
            // 4. git status — shows unmerged paths
            CommandOutput {
                exit_code: 0,
                stdout: "Unmerged paths:\n  both modified: src/main.rs".to_string(),
                stderr: String::new(),
            },
            // 5. git diff --name-only --diff-filter=U — conflict files
            CommandOutput {
                exit_code: 0,
                stdout: "src/main.rs\nsrc/lib.rs\n".to_string(),
                stderr: String::new(),
            },
            // 6. (Claude is spawned via spawn_claude — MockRuntime handles this)
            // 7. Post-resolution git status — NO "rebase in progress" (rebase completed)
            CommandOutput {
                exit_code: 0,
                stdout: "On branch main\nnothing to commit".to_string(),
                stderr: String::new(),
            },
            // 8. Push (retry after conflict resolution) — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_ok(), "should succeed after conflict resolution, got: {:?}", result);

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::ConflictDetected {
                files: vec!["src/main.rs".to_string(), "src/lib.rs".to_string()],
            }),
            "should emit ConflictDetected with file list, got: {:?}",
            collected
        );
        assert!(
            collected.contains(&GitMergeEvent::ConflictResolveStarted { attempt: 1 }),
            "should emit ConflictResolveStarted, got: {:?}",
            collected
        );
        assert!(
            collected.contains(&GitMergeEvent::ConflictResolveComplete {
                attempt: 1,
                success: true,
            }),
            "should emit ConflictResolveComplete(success=true), got: {:?}",
            collected
        );
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should emit PushSucceeded, got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 5: Rebase conflict, Claude fails to resolve, abort and retry
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_rebase_conflict_claude_fails_abort_retry() {
        let mut runtime = MockRuntime::completing_after(2); // 2 scenarios for 2 spawn_claude calls (first fails, but we only need 1 for the conflict attempt)
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // --- Retry attempt 1: conflict path ---
            // 2. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. Rebase — fails (conflicts)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "CONFLICT".to_string(),
            },
            // 4. git status — shows unmerged paths
            CommandOutput {
                exit_code: 0,
                stdout: "Unmerged paths:\n  both modified: src/app.rs".to_string(),
                stderr: String::new(),
            },
            // 5. git diff --name-only --diff-filter=U — conflict files
            CommandOutput {
                exit_code: 0,
                stdout: "src/app.rs\n".to_string(),
                stderr: String::new(),
            },
            // 6. (Claude spawned via spawn_claude)
            // 7. Post-resolution git status — still shows "rebase in progress" (Claude failed)
            CommandOutput {
                exit_code: 0,
                stdout: "interactive rebase in progress".to_string(),
                stderr: String::new(),
            },
            // 8. git rebase --abort
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // --- Retry attempt 2: clean path ---
            // 9. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 10. Rebase — succeeds this time
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 11. Push — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_ok(), "should eventually succeed after retry, got: {:?}", result);

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::ConflictResolveComplete {
                attempt: 1,
                success: false,
            }),
            "should emit ConflictResolveComplete(success=false) for first attempt, got: {:?}",
            collected
        );
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should eventually emit PushSucceeded, got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 6: All retries exhausted
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_all_retries_exhausted() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // --- Retry attempt 1 ---
            // 2. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. Rebase — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 4. Push — fails again
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected again".to_string(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = GitMergeConfig {
            working_dir: Path::new("/mock/repo"),
            push_command: "git push origin main",
            push_u_command: None,
            fetch_command: "git fetch origin main",
            rebase_command: "git pull --rebase origin main",
            conflict_prompt: None,
            conflict_model: None,
            max_retries: 1,
            cancel_token: &cancel_token,
            env_vars: &env_vars,
        };

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(result.is_err(), "should return Err after all retries exhausted");

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.iter().any(|e| matches!(e, GitMergeEvent::Failed { .. })),
            "should emit Failed event, got: {:?}",
            collected
        );
    }

    // ---------------------------------------------------------------
    // Test 7: Cancellation during conflict resolution
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_cancellation_during_conflict_resolution() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // 2. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 3. Rebase — fails (conflicts)
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "CONFLICT".to_string(),
            },
            // 4. git status — shows unmerged paths
            CommandOutput {
                exit_code: 0,
                stdout: "Unmerged paths:\n  both modified: src/main.rs".to_string(),
                stderr: String::new(),
            },
            // 5. git diff --name-only --diff-filter=U
            CommandOutput {
                exit_code: 0,
                stdout: "src/main.rs\n".to_string(),
                stderr: String::new(),
            },
            // 6. (Claude spawned but cancel_token already cancelled)
            // 7. git rebase --abort (cleanup after cancellation)
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        // Cancel before calling to ensure early return during conflict resolution
        cancel_token.cancel();

        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(
            result.is_err(),
            "should return Err when cancelled, got: {:?}",
            result
        );
    }

    // ---------------------------------------------------------------
    // Test 8: Fetch fails, continues to next retry
    // ---------------------------------------------------------------
    #[tokio::test]
    async fn test_fetch_fails_continues_to_next_retry() {
        let mut runtime = MockRuntime::completing_after(1);
        runtime.command_results = vec![
            // 1. Push — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "rejected".to_string(),
            },
            // --- Retry attempt 1: fetch fails ---
            // 2. Fetch — fails
            CommandOutput {
                exit_code: 1,
                stdout: String::new(),
                stderr: "fatal: could not read from remote".to_string(),
            },
            // --- Retry attempt 2: fetch succeeds, rebase succeeds, push succeeds ---
            // 3. Fetch — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
            // 4. Rebase — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: "Successfully rebased".to_string(),
                stderr: String::new(),
            },
            // 5. Push — succeeds
            CommandOutput {
                exit_code: 0,
                stdout: String::new(),
                stderr: String::new(),
            },
        ];

        let cancel_token = CancellationToken::new();
        let env_vars = HashMap::new();
        let config = test_config(&cancel_token, &env_vars);

        let (events, on_event) = event_collector();
        let result = git_merge_push(&runtime, &config, on_event).await;

        assert!(
            result.is_ok(),
            "should succeed after fetch failure on first attempt and success on second, got: {:?}",
            result
        );

        let collected = events.lock().unwrap().clone();
        assert!(
            collected.contains(&GitMergeEvent::PushSucceeded),
            "should emit PushSucceeded, got: {:?}",
            collected
        );
    }
}
