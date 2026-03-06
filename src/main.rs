use std::path::PathBuf;

use yarr::runtime::{MockRuntime, WslRuntime};
use yarr::session::{SessionConfig, SessionRunner};
use yarr::trace::TraceCollector;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("mock");

    match mode {
        "mock" => run_mock_demo().await,
        "wsl" => run_wsl_demo().await,
        _ => {
            eprintln!("Usage: yarr [mock|wsl]");
            eprintln!("  mock  - Run with mock runtime (no Claude CLI needed)");
            eprintln!("  wsl   - Run with WSL runtime (requires Claude Code in WSL)");
            std::process::exit(1);
        }
    }
}

async fn run_mock_demo() -> anyhow::Result<()> {
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║  Claude Harness - Tracer Bullet (Mock Mode)        ║");
    println!("╚══════════════════════════════════════════════════════╝");
    println!();

    let runtime = MockRuntime::completing_after(3);

    let config = SessionConfig {
        repo_path: PathBuf::from("/home/user/my-project"),
        prompt: concat!(
            "Read the PRD at prd.md and progress.md. ",
            "Pick the next unchecked task, implement it, ",
            "update progress.md, and commit. ",
            "When all tasks are done, output <promise>COMPLETE</promise>."
        )
        .to_string(),
        max_iterations: 10,
        completion_signal: "<promise>COMPLETE</promise>".to_string(),
        extra_args: vec!["--allowedTools".to_string(), "Bash,Read,Write".to_string()],
        inter_iteration_delay_ms: 100,
    };

    let collector = TraceCollector::new("./traces");

    let runner = SessionRunner::new(config, collector).on_iteration_complete(Box::new(
        |iteration, output| {
            println!(
                "  [callback] Iteration {iteration} → session={}",
                output.session_id.as_deref().unwrap_or("n/a")
            );
        },
    ));

    let trace = runner.run(&runtime).await?;

    println!("Final outcome: {:?}", trace.outcome);
    println!("Trace file written to ./traces/");

    Ok(())
}

async fn run_wsl_demo() -> anyhow::Result<()> {
    println!("╔══════════════════════════════════════════════════════╗");
    println!("║  Claude Harness - Tracer Bullet (WSL Mode)         ║");
    println!("╚══════════════════════════════════════════════════════╝");
    println!();

    let runtime = WslRuntime::new();

    let repo_path = std::env::var("HARNESS_REPO")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    println!("[harness] Target repo: {}", repo_path.display());

    let config = SessionConfig {
        repo_path,
        prompt: concat!(
            "Read the PRD at prd.md and progress.md. ",
            "Pick the next unchecked task, implement it, ",
            "update progress.md, and commit. ",
            "When all tasks are done, output <promise>COMPLETE</promise>."
        )
        .to_string(),
        max_iterations: 5,
        completion_signal: "<promise>COMPLETE</promise>".to_string(),
        extra_args: vec![
            "--allowedTools".to_string(),
            "Bash,Read,Write".to_string(),
            "--dangerously-skip-permissions".to_string(),
        ],
        inter_iteration_delay_ms: 2000,
    };

    let collector = TraceCollector::new("./traces");

    let runner = SessionRunner::new(config, collector).on_iteration_complete(Box::new(
        |iteration, output| {
            println!(
                "  [callback] Iteration {iteration}: cost=${:.4}",
                output.total_cost_usd.unwrap_or(0.0)
            );
        },
    ));

    let trace = runner.run(&runtime).await?;

    println!("Final outcome: {:?}", trace.outcome);

    Ok(())
}
