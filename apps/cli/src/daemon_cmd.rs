//! `opensesame daemon`: run the local agent daemon in this process, start or
//! stop it in the background, and read or approve what it holds (ADR 0017).
use crate::daemon_toolbar::ToolbarCmd;
#[path = "daemon_drive.rs"]
mod daemon_drive;
#[path = "daemon_fill.rs"]
mod daemon_fill;
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
    /// Manage the tailnet's devices from this machine (ADR 0169).
    #[command(subcommand)]
    Tailnet(daemon_tailnet::TailnetCmd),
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
        DaemonCmd::Tailnet(verb) => daemon_tailnet::run(verb).await?,
        DaemonCmd::Fill(verb) => {
            daemon_fill::run(base, operator_token.as_deref(), verb).await?;
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
    let program = env::current_exe().unwrap_or_else(|_| PathBuf::from("opensesame"));
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
mod tests {
    use super::{read_log, LogRead};
    use std::path::Path;

    fn dir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn no_logfile_falls_through_to_the_health_probe() {
        let d = dir();
        let log = d.path().join("daemon.log");
        assert!(matches!(read_log(&log, None), LogRead::Missing));
    }

    #[test]
    fn plaintext_log_with_no_key_is_read_scrubbed() {
        let d = dir();
        let log = d.path().join("daemon.log");
        std::fs::write(&log, "started ok\nlogin password=hunter2value\n").unwrap();
        assert!(!d.path().join("daemon.log.key").exists());
        match read_log(&log, None) {
            LogRead::Lines(lines) => {
                assert_eq!(lines.len(), 2);
                assert_eq!(lines[0], "started ok");
                assert!(!lines.join("\n").contains("hunter2value"), "{lines:?}");
            }
            other => panic!("expected lines, got {other:?}"),
        }
        assert!(
            !d.path().join("daemon.log.key").exists(),
            "never creates a key"
        );
    }

    #[test]
    fn sealed_log_with_no_key_is_unreadable() {
        let d = dir();
        let log = d.path().join("daemon.log");
        let key = opensesame_sealed_log::LogKey::generate();
        let sealed = opensesame_sealed_log::seal_line(&key, "secret line");
        std::fs::write(&log, format!("{sealed}\n")).unwrap();
        assert!(matches!(read_log(&log, None), LogRead::Unreadable(_)));
    }

    #[test]
    fn sealed_log_with_its_key_is_opened() {
        let d = dir();
        let log: &Path = &d.path().join("daemon.log");
        let key_path = d.path().join("daemon.log.key");
        let key = opensesame_sealed_log::LogKey::load_or_create(&key_path).unwrap();
        let sealed = opensesame_sealed_log::seal_line(&key, "hello");
        std::fs::write(log, format!("{sealed}\n")).unwrap();
        match read_log(log, None) {
            LogRead::Lines(lines) => assert_eq!(lines, vec!["hello".to_owned()]),
            other => panic!("expected lines, got {other:?}"),
        }
    }

    #[test]
    fn daemon_args_print_no_operator_token() {
        let args = super::DaemonArgs {
            url: "http://127.0.0.1:18790".into(),
            operator_token: Some("operator-12345".into()),
            cmd: super::DaemonCmd::Status,
        };
        let shown = format!("{args:?}");
        assert!(
            shown.contains("[REDACTED]") && shown.contains("18790"),
            "{shown}"
        );
        assert!(!shown.contains("operator-12345"), "{shown}");
    }
}
