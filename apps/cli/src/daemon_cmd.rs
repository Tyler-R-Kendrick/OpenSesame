//! `opensesame daemon`: run the local agent daemon in this process, start or
//! stop it in the background, and read or approve what it holds (ADR 0017).
use crate::daemon_toolbar::ToolbarCmd;
#[path = "daemon_drive.rs"]
mod daemon_drive;
#[path = "daemon_fill.rs"]
mod daemon_fill;
#[path = "daemon_helpers.rs"]
mod daemon_helpers;
#[path = "daemon_root_trust.rs"]
mod daemon_root_trust;
#[path = "daemon_tailnet.rs"]
mod daemon_tailnet;
use clap::Subcommand;
use opensesame_host_core::endpoints::{self, DAEMON};
use serde_json::json;
use std::{
    env,
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
};

/// Flags shared by every `opensesame daemon` verb.
#[derive(clap::Args)]
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

impl std::fmt::Debug for DaemonArgs {
    /// The operator token gates every daemon route; it never prints.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DaemonArgs")
            .field("url", &self.url)
            .field(
                "operator_token",
                &self.operator_token.as_ref().map(|_| "[REDACTED]"),
            )
            .field("cmd", &self.cmd)
            .finish()
    }
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
    /// Approve, revoke or list the companion autofill extension's pairing
    /// (the optional `browser-autofill` plugin, ADR 0150 §7).
    #[command(subcommand)]
    Fill(daemon_fill::FillCmd),
    /// Allow, revoke or list the connections the credential helpers may mint
    /// on the daemon's socket with no operator token (ADR 0138 §2).
    #[command(subcommand)]
    Helpers(daemon_helpers::HelpersCmd),
    /// Manage the tailnet's devices from this machine (ADR 0169).
    #[command(subcommand)]
    Tailnet(daemon_tailnet::TailnetCmd),
    #[command(flatten)]
    Toolbar(ToolbarCmd),
    /// Enroll the daemon CLI root trust key (PAKE; operator only).
    RootTrust {
        #[command(subcommand)]
        cmd: RootTrustCmd,
    },
}

#[derive(Subcommand, Debug)]
enum RootTrustCmd {
    /// Run SPAKE2 enrollment after an OS secure prompt (headless hosts refuse).
    Enroll,
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
        DaemonCmd::Tailnet(verb) => daemon_tailnet::run(verb).await?,
        DaemonCmd::Fill(verb) => {
            daemon_fill::run(base, operator_token.as_deref(), verb).await?;
        }
        DaemonCmd::Helpers(verb) => {
            daemon_helpers::run(base, operator_token.as_deref(), verb).await?;
        }
        DaemonCmd::Toolbar(verb) => {
            crate::daemon_toolbar::run(base, operator_token.as_deref(), verb).await?;
        }
        DaemonCmd::RootTrust { cmd } => match cmd {
            RootTrustCmd::Enroll => {
                daemon_root_trust::run(base, operator_token.as_deref()).await?;
            }
        },
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

/// What `daemon logs` finds at the logfile.
#[derive(Debug)]
enum LogRead {
    /// No logfile: the health probe is the next thing to try.
    Missing,
    Lines(Vec<String>),
    Unreadable(std::io::Error),
}

/// Read the logfile's tail. The file is looked for first and the key only if it
/// is there, so a fresh machine reaches the health probe. A log an older build
/// wrote in the clear needs no key (its lines are scrubbed on the way out); a
/// sealed line that no key opens makes the whole log unreadable, never a wall of
/// placeholders.
fn read_log(logfile: &Path, key_override: Option<&str>) -> LogRead {
    if !logfile.exists() {
        return LogRead::Missing;
    }
    let key_path = opensesame_sealed_log::key_path_for(logfile, key_override);
    let key = match opensesame_sealed_log::LogKey::load(&key_path) {
        Ok(key) => Some(key),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return LogRead::Unreadable(error),
    };
    // Without a key a throwaway one opens nothing, so every sealed line comes
    // back as the placeholder and is caught below.
    let keyless = key.is_none();
    let key = key.unwrap_or_else(opensesame_sealed_log::LogKey::generate);
    match opensesame_sealed_log::read_tail(logfile, &key, 40) {
        Ok(lines) if keyless && lines.iter().any(|l| l == opensesame_sealed_log::UNREADABLE) => {
            LogRead::Unreadable(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("the log key {} is missing", key_path.display()),
            ))
        }
        Ok(lines) => LogRead::Lines(lines),
        Err(error) => LogRead::Unreadable(error),
    }
}

async fn show_logs(base: &str, logfile: &str) {
    let tail = match read_log(
        Path::new(logfile),
        crate::log_sink::key_override().as_deref(),
    ) {
        LogRead::Missing => Ok(None),
        LogRead::Lines(lines) => Ok(Some(lines)),
        LogRead::Unreadable(error) => Err(error),
    };
    if let Ok(Some(out)) = tail {
        println!("{}", out.join("\n"));
        if out.is_empty() {
            println!(
                "{}",
                json!({"status":"empty","logfile": logfile, "hint":"start daemon to capture logs"})
            );
        }
    } else if let Err(error) = tail {
        println!(
            "{}",
            json!({"status":"unreadable","logfile": logfile, "error": error.to_string(),
                   "hint": "the log is sealed; its key is beside it or at OPENSESAME_LOG_KEY_FILE"})
        );
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

/// `kill -TERM pid`, with `kill` from a trusted `PATH` entry and the common
/// environment only.
#[cfg(unix)]
fn terminate(pid: u32) -> bool {
    opensesame_trusted_exec::command_on_path("kill").is_ok_and(|mut kill| {
        let sent = kill.args(["-TERM", &pid.to_string()]).status();
        sent.is_ok_and(|status| status.success())
    })
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
                    let stopped = terminate(pid);
                    let _ = std::fs::remove_file(pidfile);
                    println!(
                        "{}",
                        json!({
                            "status": if stopped { "stopped" } else { "error" },
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

/// The binary the daemon is started from: this one. When this process cannot
/// say where it is, there is no other `opensesame` to guess at on `PATH`.
fn daemon_program(exe: std::io::Result<PathBuf>) -> Result<PathBuf, String> {
    exe.map_err(|error| {
        format!("cannot tell where this opensesame is, so cannot start it: {error}")
    })
}

fn start_daemon(home: &str, pidfile: &str, logfile: &str) {
    let _ = std::fs::create_dir_all(format!("{home}/.opensesame"));
    // The daemon's log is sealed (ADR 0157): opened and keyed here first, so a
    // log that cannot be kept is reported now rather than lost, and one an older
    // build wrote in the clear is sealed before the daemon appends to it.
    if let Err(error) = crate::log_sink::open(Path::new(logfile)) {
        println!(
            "{}",
            json!({"status":"error","error": format!("cannot open the sealed log: {error}"),
                   "hint": "run it in the foreground with: opensesame daemon run"})
        );
        return;
    }
    let program = match daemon_program(env::current_exe()) {
        Ok(program) => program,
        Err(error) => {
            println!("{}", json!({"status":"error","error": error}));
            return;
        }
    };
    match StdCommand::new(program)
        .args(["daemon", "run"])
        .env(crate::log_sink::ENV_LOG_FILE, logfile)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => {
            let pid = child.id();
            let _ = crate::write_private(Path::new(pidfile), format!("{pid}\n").as_bytes());
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

#[cfg(test)]
mod tests;
