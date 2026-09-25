//! `opensesame daemon`: run the local agent daemon in this process, start or
//! stop it in the background, and read or approve what it holds (ADR 0017).
use crate::daemon_toolbar::ToolbarCmd;
#[path = "daemon_drive.rs"]
mod daemon_drive;
use clap::Subcommand;
use opensesame_host_core::endpoints::{self, DAEMON};
use serde_json::json;
use std::{
    env,
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
};

/// Flags shared by every `opensesame daemon` verb.
#[derive(clap::Args, Debug)]
pub struct DaemonArgs {
    #[arg(long, env = endpoints::env(DAEMON), default_value_t = endpoints::fallback(DAEMON))]
    url: String,
    /// The daemon's operator token. Every route but /health is operator-gated,
    /// so without this the daemon answers 401 and nothing is approved. Prefer
    /// the environment variable so it stays out of shell history and `ps`.
    #[arg(long, env = "OPENSESAME_OPERATOR_TOKEN", hide_env_values = true)]
    operator_token: Option<String>,
    #[command(subcommand)]
    cmd: DaemonCmd,
}

impl DaemonArgs {
    /// Whether this invocation runs the daemon in-process.
    pub fn is_run(&self) -> bool {
        matches!(self.cmd, DaemonCmd::Run(_))
    }
}

#[derive(Subcommand, Debug)]
enum DaemonCmd {
    /// Run the daemon in this process until it is stopped.
    Run(Box<opensesame_daemon::Args>),
    /// Print how to run the daemon.
    Install,
    /// Start `opensesame daemon run` in the background (best-effort).
    Start,
    /// Probe daemon /health.
    Status,
    /// Tail daemon logfile (`~/.opensesame/daemon.log`).
    Logs,
    /// SIGTERM via pidfile.
    Stop,
    /// This machine's tailnet vault drive (ADR 0144).
    #[command(subcommand)]
    Drive(daemon_drive::DriveCmd),
    #[command(flatten)]
    Toolbar(ToolbarCmd),
}

/// Entry point called from `main.rs`'s `Commands::Daemon` arm.
pub async fn run(args: DaemonArgs) -> anyhow::Result<()> {
    let DaemonArgs {
        url,
        operator_token,
        cmd,
    } = args;
    let base = url.trim_end_matches('/');
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    let pidfile = env::var("OPENSESAME_DAEMON_PIDFILE")
        .unwrap_or_else(|_| format!("{home}/.opensesame/daemon.pid"));
    let logfile = env::var("OPENSESAME_DAEMON_LOGFILE")
        .unwrap_or_else(|_| format!("{home}/.opensesame/daemon.log"));
    match cmd {
        DaemonCmd::Run(daemon) => opensesame_daemon::run(*daemon).await?,
        DaemonCmd::Drive(verb) => {
            daemon_drive::run(base, operator_token.as_deref(), verb).await?;
        }
        DaemonCmd::Toolbar(verb) => {
            crate::daemon_toolbar::run(base, operator_token.as_deref(), verb).await?;
        }
        DaemonCmd::Install => {
            println!(
                "{}",
                json!({
                    "status": "ok",
                    "command": "opensesame daemon run",
                    "hint": "the daemon is this binary; run it as a login item or with `opensesame daemon start`",
                    "listen_default": endpoints::endpoint(DAEMON).listen.default,
                    "env": [endpoints::listen_env(DAEMON), "OPENSESAME_DAEMON_PIDFILE"]
                })
            );
        }
        DaemonCmd::Start => start_daemon(&home, &pidfile, &logfile),
        DaemonCmd::Status => {
            let client = reqwest::Client::new();
            match client.get(format!("{base}/health")).send().await {
                Ok(resp) => {
                    let body: serde_json::Value = resp.json().await.unwrap_or(json!({"raw":"ok"}));
                    println!(
                        "{}",
                        json!({"status":"up","health": body, "pidfile": pidfile})
                    );
                }
                Err(e) => println!("{}", json!({"status":"down","error": e.to_string()})),
            }
        }
        DaemonCmd::Logs => show_logs(base, &logfile).await,
        DaemonCmd::Stop => stop_daemon(&pidfile),
    }
    Ok(())
}

async fn show_logs(base: &str, logfile: &str) {
    if let Ok(content) = std::fs::read_to_string(logfile) {
        let lines: Vec<&str> = content.lines().rev().take(40).collect();
        let out: Vec<&str> = lines.into_iter().rev().collect();
        println!("{}", out.join("\n"));
        if out.is_empty() {
            println!(
                "{}",
                json!({"status":"empty","logfile": logfile, "hint":"start daemon to capture logs"})
            );
        }
    } else {
        let client = reqwest::Client::new();
        match client.get(format!("{base}/health")).send().await {
            Ok(resp) => {
                let body: serde_json::Value = resp.json().await.unwrap_or(json!({"raw":"ok"}));
                println!(
                    "{}",
                    json!({"status":"up","health": body, "hint": format!("no logfile at {logfile}")})
                );
            }
            Err(e) => println!("{}", json!({"status":"down","error": e.to_string()})),
        }
    }
}

fn stop_daemon(pidfile: &str) {
    match std::fs::read_to_string(pidfile) {
        Ok(raw) => {
            let pid: u32 = raw.trim().parse().unwrap_or(0);
            if pid == 0 {
                println!("{}", json!({"status":"error","error":"invalid pidfile"}));
            } else {
                #[cfg(unix)]
                {
                    let status = StdCommand::new("kill")
                        .args(["-TERM", &pid.to_string()])
                        .status();
                    let _ = std::fs::remove_file(pidfile);
                    println!(
                        "{}",
                        json!({
                            "status": if status.map(|s| s.success()).unwrap_or(false) { "stopped" } else { "error" },
                            "pid": pid
                        })
                    );
                }
                #[cfg(not(unix))]
                {
                    println!(
                        "{}",
                        json!({"status":"error","error":"stop requires unix SIGTERM"})
                    );
                }
            }
        }
        Err(_) => println!(
            "{}",
            json!({"status":"not_running","hint":"no pidfile; stop `opensesame daemon run` manually"})
        ),
    }
}

fn start_daemon(home: &str, pidfile: &str, logfile: &str) {
    let _ = std::fs::create_dir_all(format!("{home}/.opensesame"));
    // The daemon's own output lands here; it is not for other accounts.
    let mut log_opts = std::fs::OpenOptions::new();
    log_opts.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        log_opts.mode(0o600);
    }
    let (stdout, stderr) = match log_opts.open(logfile) {
        Ok(file) => {
            let stderr = file.try_clone().ok();
            (Stdio::from(file), stderr.map_or(Stdio::null(), Stdio::from))
        }
        Err(_) => (Stdio::null(), Stdio::null()),
    };
    let program = env::current_exe().unwrap_or_else(|_| PathBuf::from("opensesame"));
    match StdCommand::new(program)
        .args(["daemon", "run"])
        .stdout(stdout)
        .stderr(stderr)
        .spawn()
    {
        Ok(child) => {
            let pid = child.id();
            let _ = std::fs::write(pidfile, format!("{pid}\n"));
            // Detach: forget Child so Drop doesn't kill it.
            std::mem::forget(child);
            println!(
                "{}",
                json!({"status":"started","pid": pid, "pidfile": pidfile, "logfile": logfile})
            );
        }
        Err(error) => println!(
            "{}",
            json!({
                "status": "error",
                "error": error.to_string(),
                "hint": "run it in the foreground with: opensesame daemon run"
            })
        ),
    }
}
