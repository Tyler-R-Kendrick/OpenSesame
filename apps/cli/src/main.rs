use clap::{Parser, Subcommand, ValueEnum};
use opensesame_authn::{
    detect_signals_from_env, resolve_login_flow, DevicePollState, DeviceServerStatus, LoginFlow,
    OpenBrowser, WhoAmI,
};
use opensesame_domain::DevDeliveryPolicy;
use opensesame_env_spec::{parse_schema_file, resolve_for_delivery, schema_summary};
use serde_json::json;
use std::{
    env,
    path::PathBuf,
    process::{Command as StdCommand, Stdio},
    time::Duration,
};

#[derive(Parser, Debug)]
#[command(name = "opensesame", about = "OpenSesame CLI — credentials as capabilities")]
struct Cli {
    #[arg(long, env = "OPENSESAME_SERVER", global = true, default_value = "http://127.0.0.1:8787")]
    server: String,
    #[arg(long, global = true, default_value = "json")]
    output: String,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    Login {
        #[arg(long, value_enum, default_value = "auto")]
        flow: FlowArg,
        #[arg(long, default_value = "false")]
        no_browser: bool,
        #[arg(long, value_enum, default_value = "auto")]
        open_browser: OpenBrowserArg,
    },
    Logout,
    Status,
    Whoami,
    #[command(name = "auth")]
    Auth {
        #[command(subcommand)]
        cmd: AuthCmd,
    },
    Invoke {
        /// ConnectionRef URI (conn://...) or logical name — never a SecretRef.
        #[arg(long = "connection-ref", alias = "connection")]
        connection_ref: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        resource: String,
        #[arg(long)]
        input: Option<PathBuf>,
        #[arg(long, default_value = "1")]
        invoke_level: u8,
    },
    Receipt {
        #[command(subcommand)]
        cmd: ReceiptCmd,
    },
    Doctor,
    /// Developer @env-spec workflow (ADR 0006).
    Dev {
        /// Force agent delivery policy (deny materialize).
        #[arg(long, global = true, default_value = "false")]
        agent: bool,
        #[arg(long, global = true, default_value = ".env.schema")]
        schema: PathBuf,
        #[command(subcommand)]
        cmd: DevCmd,
    },
    /// Install/control the local host daemon (ADR 0017).
    Daemon {
        #[arg(
            long,
            env = "OPENSESAME_DAEMON_URL",
            default_value = "http://127.0.0.1:18790"
        )]
        url: String,
        #[command(subcommand)]
        cmd: DaemonCmd,
    },
}

#[derive(Subcommand, Debug)]
enum DaemonCmd {
    /// Print how to install/start the daemon binary.
    Install,
    /// Spawn `opensesame-daemon` in the background (best-effort).
    Start,
    /// Probe daemon /health.
    Status,
    /// Alias for status (logs not tailed in this stub).
    Logs,
    Stop,
}

#[derive(Subcommand, Debug)]
enum DevCmd {
    /// Parse schema; print metadata without secrets.
    Check,
    /// Resolve env under delivery policy (redacted summary + projected values).
    Resolve,
    /// Run a child process with projected env (`opensesame dev run -- npm run dev`).
    Run {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true, required = true)]
        args: Vec<String>,
    },
}

#[derive(Subcommand, Debug)]
enum AuthCmd {
    Doctor,
}

#[derive(Subcommand, Debug)]
enum ReceiptCmd {
    Verify { id: String },
}

#[derive(Clone, ValueEnum, Debug)]
enum FlowArg {
    Auto,
    Loopback,
    Device,
    Ciba,
    Workload,
}

#[derive(Clone, ValueEnum, Debug)]
enum OpenBrowserArg {
    Auto,
    Always,
    Never,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter("warn")
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    match cli.command {
        Commands::Login {
            flow,
            no_browser,
            open_browser,
        } => login(&cli.server, flow, no_browser, open_browser).await?,
        Commands::Logout => {
            let path = session_path()?;
            let _ = std::fs::remove_file(path);
            println!("{}", json!({"status":"logged_out"}));
        }
        Commands::Status => status(&cli.server).await?,
        Commands::Whoami => whoami(&cli.server).await?,
        Commands::Auth { cmd: AuthCmd::Doctor } => doctor(&cli.server).await?,
        Commands::Invoke {
            connection_ref,
            operation,
            resource,
            input,
            invoke_level,
        } => invoke(
            &cli.server,
            &connection_ref,
            &operation,
            &resource,
            input,
            invoke_level,
        )
        .await?,
        Commands::Receipt {
            cmd: ReceiptCmd::Verify { id },
        } => verify_receipt(&cli.server, &id).await?,
        Commands::Doctor => doctor(&cli.server).await?,
        Commands::Dev {
            cmd,
            agent,
            schema,
        } => dev_cmd(cmd, agent, schema)?,
        Commands::Daemon { url, cmd } => daemon_cmd(&url, cmd).await?,
    }
    Ok(())
}

async fn daemon_cmd(url: &str, cmd: DaemonCmd) -> anyhow::Result<()> {
    let base = url.trim_end_matches('/');
    match cmd {
        DaemonCmd::Install => {
            println!(
                "{}",
                json!({
                    "status": "ok",
                    "hint": "cargo build -p opensesame-daemon && install target/debug/opensesame-daemon on PATH",
                    "listen_default": "127.0.0.1:18790",
                    "env": ["OPENSESAME_DAEMON_LISTEN", "OPENSESAME_AGENT_LISTEN"]
                })
            );
        }
        DaemonCmd::Start => {
            let child = StdCommand::new("opensesame-daemon")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match child {
                Ok(c) => println!("{}", json!({"status":"started","pid": c.id()})),
                Err(e) => println!(
                    "{}",
                    json!({
                        "status": "error",
                        "error": e.to_string(),
                        "hint": "build with: cargo build -p opensesame-daemon"
                    })
                ),
            }
        }
        DaemonCmd::Status | DaemonCmd::Logs => {
            let client = reqwest::Client::new();
            match client.get(format!("{base}/health")).send().await {
                Ok(resp) => {
                    let body: serde_json::Value = resp.json().await.unwrap_or(json!({"raw":"ok"}));
                    println!("{}", json!({"status":"up","health": body}));
                }
                Err(e) => println!("{}", json!({"status":"down","error": e.to_string()})),
            }
        }
        DaemonCmd::Stop => {
            println!(
                "{}",
                json!({
                    "status": "not_implemented",
                    "hint": "send SIGTERM to opensesame-daemon pid (no pidfile in this slice)"
                })
            );
        }
    }
    Ok(())
}

fn dev_cmd(cmd: DevCmd, agent: bool, schema: PathBuf) -> anyhow::Result<()> {
    match cmd {
        DevCmd::Check => {
            let doc = parse_schema_file(&schema)
                .map_err(|e| anyhow::anyhow!("env-spec parse failed: {e}"))?;
            let summary = schema_summary(&doc);
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        DevCmd::Resolve => {
            let doc = parse_schema_file(&schema)
                .map_err(|e| anyhow::anyhow!("env-spec parse failed: {e}"))?;
            let policy = if agent {
                DevDeliveryPolicy::agent_default()
            } else {
                DevDeliveryPolicy::development_default()
            };
            let entries = resolve_for_delivery(&doc, &policy, agent)
                .map_err(|e| anyhow::anyhow!("resolve failed: {e}"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "agent": agent,
                    "policy_denies_materialize": !policy.allows(opensesame_domain::CredentialDeliveryMode::Materialize),
                    "summary": schema_summary(&doc),
                    "entries": entries,
                }))?
            );
        }
        DevCmd::Run { args } => {
            if args.is_empty() {
                anyhow::bail!("usage: opensesame dev run [--agent] -- <cmd>");
            }
            let doc = parse_schema_file(&schema)
                .map_err(|e| anyhow::anyhow!("env-spec parse failed: {e}"))?;
            let policy = if agent {
                DevDeliveryPolicy::agent_default()
            } else {
                DevDeliveryPolicy::development_default()
            };
            let entries = resolve_for_delivery(&doc, &policy, agent)
                .map_err(|e| anyhow::anyhow!("resolve failed: {e}"))?;
            let mut child = StdCommand::new(&args[0]);
            if args.len() > 1 {
                child.args(&args[1..]);
            }
            for e in &entries {
                if let Some(v) = &e.env_value {
                    if !e.omitted {
                        child.env(&e.key, v);
                    }
                }
            }
            child
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::inherit());
            let status = child.status()?;
            if !status.success() {
                std::process::exit(status.code().unwrap_or(1));
            }
        }
    }
    Ok(())
}

fn session_path() -> anyhow::Result<PathBuf> {
    let dir = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("no project dirs"))?;
    let path = dir.config_dir().join("session.json");
    std::fs::create_dir_all(dir.config_dir())?;
    Ok(path)
}

async fn login(
    server: &str,
    flow: FlowArg,
    no_browser: bool,
    open_browser: OpenBrowserArg,
) -> anyhow::Result<()> {
    let explicit = match flow {
        FlowArg::Auto => LoginFlow::Auto,
        FlowArg::Loopback => LoginFlow::Loopback,
        FlowArg::Device => LoginFlow::Device,
        FlowArg::Ciba => LoginFlow::Ciba,
        FlowArg::Workload => LoginFlow::Workload,
    };
    let mut signals = detect_signals_from_env(
        &|k| env::var(k).ok(),
        true,
        !no_browser && !matches!(open_browser, OpenBrowserArg::Never),
    );
    signals.open_browser = match open_browser {
        OpenBrowserArg::Auto => OpenBrowser::Auto,
        OpenBrowserArg::Always => OpenBrowser::Always,
        OpenBrowserArg::Never => OpenBrowser::Never,
    };
    if no_browser {
        signals.browser_launch_allowed = false;
        signals.open_browser = OpenBrowser::Never;
    }
    let selected = resolve_login_flow(explicit, &signals);
    eprintln!("selected_flow={selected:?}");

    match selected {
        LoginFlow::Device | LoginFlow::Auto => device_login(server).await?,
        LoginFlow::Loopback => {
            eprintln!("loopback PKCE selected; falling back to device when no external IdP configured in local profile");
            device_login(server).await?;
        }
        LoginFlow::Ciba => anyhow::bail!("CIBA not enabled by issuer profile"),
        LoginFlow::Workload => anyhow::bail!("configure OPENSESAME_WORKLOAD_IDENTITY for workload flow"),
    }
    Ok(())
}

async fn device_login(server: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let auth: serde_json::Value = client
        .post(format!("{server}/api/v1/device/authorize"))
        .json(&json!({"client_id":"opensesame-cli","scope":"opensesame.session"}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let device_code = auth["device_code"].as_str().unwrap().to_string();
    let user_code = auth["user_code"].as_str().unwrap();
    let verification_uri = auth["verification_uri"].as_str().unwrap();
    let interval = auth["interval"].as_u64().unwrap_or(5);
    let expires_in = auth["expires_in"].as_i64().unwrap_or(900);

    // Never print device_code
    println!("Open {verification_uri} and enter code: {user_code}");
    let approve_body = serde_json::json!({"user_code": user_code});
    println!(
        "(Or approve via: curl -s -X POST {server}/api/v1/device/approve -H 'content-type: application/json' -d '{approve_body}')"
    );

    let expires_at = chrono::Utc::now() + chrono::Duration::seconds(expires_in);
    let mut state = DevicePollState {
        interval_seconds: interval,
        expires_at,
        cancelled: false,
    };

    loop {
        tokio::time::sleep(Duration::from_secs(state.interval_seconds)).await;
        let resp = client
            .post(format!("{server}/api/v1/device/token"))
            .json(&json!({
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
            }))
            .send()
            .await?;
        let body: serde_json::Value = resp.json().await?;
        if let Some(err) = body.get("error").and_then(|e| e.as_str()) {
            let status = match err {
                "authorization_pending" => DeviceServerStatus::AuthorizationPending,
                "slow_down" => DeviceServerStatus::SlowDown,
                "access_denied" => DeviceServerStatus::AccessDenied,
                "expired_token" => DeviceServerStatus::Expired,
                other => anyhow::bail!("device token error: {other}"),
            };
            match state.next_action(chrono::Utc::now(), status) {
                Err(opensesame_authn::DeviceFlowError::AuthorizationPending)
                | Err(opensesame_authn::DeviceFlowError::SlowDown) => continue,
                Err(e) => return Err(e.into()),
                Ok(_) => unreachable!(),
            }
        } else {
            let session = body
                .get("session")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing session metadata"))?;
            // Persist opaque session metadata only — no refresh token field expected
            let path = session_path()?;
            std::fs::write(&path, serde_json::to_vec_pretty(&session)?)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = std::fs::metadata(&path)?.permissions();
                perms.set_mode(0o600);
                std::fs::set_permissions(&path, perms)?;
            }
            println!("{}", json!({"status":"logged_in","session": session}));
            let _ = state.next_action(chrono::Utc::now(), DeviceServerStatus::Success);
            break;
        }
    }
    Ok(())
}

async fn status(server: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let ready: serde_json::Value = client
        .get(format!("{server}/health/ready"))
        .send()
        .await?
        .json()
        .await?;
    let path = session_path()?;
    let has_session = path.exists();
    println!(
        "{}",
        json!({"server": server, "ready": ready, "local_session": has_session})
    );
    Ok(())
}

async fn whoami(server: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let body: WhoAmI = client
        .get(format!("{server}/api/v1/whoami"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    println!("{}", serde_json::to_string_pretty(&body)?);
    Ok(())
}

async fn invoke(
    server: &str,
    connection_ref: &str,
    operation: &str,
    resource: &str,
    input: Option<PathBuf>,
    invoke_level: u8,
) -> anyhow::Result<()> {
    let parameters = if let Some(path) = input {
        serde_json::from_str(&std::fs::read_to_string(path)?)?
    } else {
        json!({})
    };
    let client = reqwest::Client::new();
    let receipt: serde_json::Value = client
        .post(format!("{server}/api/v1/intents"))
        .json(&json!({
            "connection_ref": connection_ref,
            "operation": operation,
            "resource": resource,
            "parameters": parameters,
            "invoke_level": invoke_level,
            "idempotency_key": uuid_v4(),
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    println!("{}", serde_json::to_string_pretty(&receipt)?);
    Ok(())
}

async fn verify_receipt(server: &str, id: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let body: serde_json::Value = client
        .post(format!("{server}/api/v1/receipts/{id}/verify"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    println!("{body}");
    Ok(())
}

async fn doctor(server: &str) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let prm = client
        .get(format!("{server}/.well-known/oauth-protected-resource"))
        .send()
        .await?;
    let auth_md = client.get(format!("{server}/auth.md")).send().await?;
    let authority = client
        .get(format!("{server}/health/authority"))
        .send()
        .await?
        .json::<serde_json::Value>()
        .await?;
    let signals = detect_signals_from_env(&|k| env::var(k).ok(), true, true);
    println!(
        "{}",
        json!({
            "prm_ok": prm.status().is_success(),
            "auth_md_ok": auth_md.status().is_success(),
            "authority": authority,
            "headless_signals": {
                "ssh": signals.ssh_connection,
                "devcontainer": signals.devcontainer,
                "codespaces": signals.codespaces,
                "wsl": signals.wsl,
                "has_display": signals.has_display
            },
            "selected_auto_flow": format!("{:?}", resolve_login_flow(LoginFlow::Auto, &signals))
        })
    );
    Ok(())
}

fn uuid_v4() -> String {
    format!("{}", uuid::Uuid::new_v4())
}
