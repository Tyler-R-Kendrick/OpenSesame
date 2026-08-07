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
#[command(
    name = "opensesame",
    about = "OpenSesame CLI — credentials as capabilities"
)]
struct Cli {
    #[arg(
        long,
        env = "OPENSESAME_SERVER",
        global = true,
        default_value = "http://127.0.0.1:8787"
    )]
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
        /// Delivery mode: agent | development (alias for --agent / default).
        #[arg(long, global = true, value_enum, default_value = "auto")]
        mode: DeliveryModeArg,
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
    /// Task-scoped authority (immutable ceiling + trust ratchet).
    Task {
        #[command(subcommand)]
        cmd: TaskCmd,
    },
    /// Freeze a task-bound intent via Host API.
    Intent {
        #[command(subcommand)]
        cmd: IntentCmd,
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
    /// Tail daemon logfile (`~/.opensesame/daemon.log`).
    Logs,
    /// SIGTERM via pidfile.
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

#[derive(Subcommand, Debug)]
enum TaskCmd {
    Start {
        #[arg(long)]
        principal: String,
        #[arg(long)]
        organization: String,
        /// Repeatable capability as action=resource
        #[arg(long = "capability", required = true)]
        capabilities: Vec<String>,
        #[arg(long, default_value_t = 3600)]
        ttl_seconds: i64,
    },
    List,
    Inspect {
        id: String,
    },
    Capabilities {
        id: String,
    },
    Terminate {
        id: String,
        #[arg(long)]
        expected_state_version: Option<u64>,
    },
}

#[derive(Subcommand, Debug)]
enum IntentCmd {
    Create {
        #[arg(long)]
        task: String,
        #[arg(long)]
        operation: String,
        #[arg(long)]
        resource: String,
        #[arg(long)]
        audience: String,
        #[arg(long, default_value = "{}")]
        args: String,
        #[arg(long)]
        expected_state_version: Option<u64>,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
}

#[derive(Clone, ValueEnum, Debug)]
enum DeliveryModeArg {
    Auto,
    Agent,
    Development,
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
        Commands::Auth {
            cmd: AuthCmd::Doctor,
        } => doctor(&cli.server).await?,
        Commands::Invoke {
            connection_ref,
            operation,
            resource,
            input,
            invoke_level,
        } => {
            invoke(
                &cli.server,
                &connection_ref,
                &operation,
                &resource,
                input,
                invoke_level,
            )
            .await?
        }
        Commands::Receipt {
            cmd: ReceiptCmd::Verify { id },
        } => verify_receipt(&cli.server, &id).await?,
        Commands::Doctor => doctor(&cli.server).await?,
        Commands::Dev {
            cmd,
            agent,
            mode,
            schema,
        } => {
            let agent = match mode {
                DeliveryModeArg::Agent => true,
                DeliveryModeArg::Development => false,
                DeliveryModeArg::Auto => agent,
            };
            dev_cmd(cmd, agent, schema)?
        }
        Commands::Daemon { url, cmd } => daemon_cmd(&url, cmd).await?,
        Commands::Task { cmd } => task_cmd(&cli.server, &cli.output, cmd).await?,
        Commands::Intent { cmd } => intent_cmd(&cli.server, &cli.output, cmd).await?,
    }
    Ok(())
}

async fn daemon_cmd(url: &str, cmd: DaemonCmd) -> anyhow::Result<()> {
    let base = url.trim_end_matches('/');
    let home = env::var("HOME").unwrap_or_else(|_| ".".into());
    let pidfile = env::var("OPENSESAME_DAEMON_PIDFILE")
        .unwrap_or_else(|_| format!("{home}/.opensesame/daemon.pid"));
    let logfile = env::var("OPENSESAME_DAEMON_LOGFILE")
        .unwrap_or_else(|_| format!("{home}/.opensesame/daemon.log"));
    match cmd {
        DaemonCmd::Install => {
            let dest = format!("{home}/.local/bin/opensesame-daemon");
            let src_candidates = [
                "target/debug/opensesame-daemon".to_string(),
                "target/release/opensesame-daemon".to_string(),
            ];
            let mut installed = false;
            for src in &src_candidates {
                if PathBuf::from(src).exists() {
                    let _ = std::fs::create_dir_all(format!("{home}/.local/bin"));
                    if std::fs::copy(src, &dest).is_ok() {
                        installed = true;
                        #[cfg(unix)]
                        {
                            use std::os::unix::fs::PermissionsExt;
                            let _ = std::fs::set_permissions(
                                &dest,
                                std::fs::Permissions::from_mode(0o755),
                            );
                        }
                        break;
                    }
                }
            }
            println!(
                "{}",
                json!({
                    "status": if installed { "installed" } else { "ok" },
                    "path": dest,
                    "hint": "cargo build -p opensesame-daemon && opensesame daemon install",
                    "listen_default": "127.0.0.1:18790",
                    "env": ["OPENSESAME_DAEMON_LISTEN", "OPENSESAME_AGENT_LISTEN", "OPENSESAME_DAEMON_PIDFILE"]
                })
            );
        }
        DaemonCmd::Start => {
            let _ = std::fs::create_dir_all(format!("{home}/.opensesame"));
            let log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&logfile);
            let (stdout, stderr) = match log {
                Ok(f) => {
                    let f2 = f.try_clone().ok();
                    (Stdio::from(f), f2.map(Stdio::from).unwrap_or(Stdio::null()))
                }
                Err(_) => (Stdio::null(), Stdio::null()),
            };
            let child = StdCommand::new("opensesame-daemon")
                .stdout(stdout)
                .stderr(stderr)
                .spawn();
            match child {
                Ok(c) => {
                    let pid = c.id();
                    let _ = std::fs::write(&pidfile, format!("{pid}\n"));
                    // Detach: forget Child so Drop doesn't kill it
                    std::mem::forget(c);
                    println!(
                        "{}",
                        json!({"status":"started","pid": pid, "pidfile": pidfile, "logfile": logfile})
                    );
                }
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
        DaemonCmd::Logs => match std::fs::read_to_string(&logfile) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().rev().take(40).collect();
                let out: Vec<&str> = lines.into_iter().rev().collect();
                println!("{}", out.join("\n"));
                if out.is_empty() {
                    println!(
                        "{}",
                        json!({"status":"empty","logfile": logfile, "hint":"start daemon to capture logs"})
                    );
                }
            }
            Err(_) => {
                let client = reqwest::Client::new();
                match client.get(format!("{base}/health")).send().await {
                    Ok(resp) => {
                        let body: serde_json::Value =
                            resp.json().await.unwrap_or(json!({"raw":"ok"}));
                        println!(
                            "{}",
                            json!({"status":"up","health": body, "hint": format!("no logfile at {logfile}")})
                        );
                    }
                    Err(e) => println!("{}", json!({"status":"down","error": e.to_string()})),
                }
            }
        },
        DaemonCmd::Stop => match std::fs::read_to_string(&pidfile) {
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
                        let _ = std::fs::remove_file(&pidfile);
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
                json!({"status":"not_running","hint":"no pidfile; kill opensesame-daemon manually"})
            ),
        },
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

fn load_access_token() -> anyhow::Result<String> {
    let path = session_path()?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| anyhow::anyhow!("no local session — run `opensesame login` first"))?;
    let v: serde_json::Value = serde_json::from_str(&raw)?;
    if let Some(t) = v.get("access_token").and_then(|x| x.as_str()) {
        return Ok(t.to_string());
    }
    if let Some(id) = v.get("session_id").and_then(|x| x.as_str()) {
        return Ok(format!("opaque-session:{id}"));
    }
    anyhow::bail!("session.json missing access_token / session_id")
}

fn operator_token() -> String {
    env::var("OPENSESAME_OPERATOR_TOKEN").unwrap_or_else(|_| "opensesame-dev-operator".into())
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
        LoginFlow::Workload => {
            anyhow::bail!("configure OPENSESAME_WORKLOAD_IDENTITY for workload flow")
        }
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
    let op = operator_token();
    println!(
        "(Or approve via: curl -s -X POST {server}/api/v1/device/approve -H 'content-type: application/json' -H 'x-opensesame-operator: {op}' -d '{approve_body}')"
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
            let mut session = body
                .get("session")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("missing session metadata"))?;
            if let Some(at) = body.get("access_token").cloned() {
                if let Some(obj) = session.as_object_mut() {
                    obj.insert("access_token".into(), at);
                }
            }
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
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let body: WhoAmI = client
        .get(format!("{server}/api/v1/whoami"))
        .bearer_auth(token)
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
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let receipt: serde_json::Value = client
        .post(format!("{server}/api/v1/intents"))
        .bearer_auth(token)
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
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let body: serde_json::Value = client
        .post(format!("{server}/api/v1/receipts/{id}/verify"))
        .bearer_auth(token)
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
    uuid::Uuid::new_v4().to_string()
}

fn print_output(output: &str, value: &serde_json::Value) -> anyhow::Result<()> {
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{value}");
    }
    Ok(())
}

fn parse_capability(raw: &str) -> anyhow::Result<serde_json::Value> {
    let (action, resource) = raw
        .split_once('=')
        .ok_or_else(|| anyhow::anyhow!("capability must be action=resource, got {raw}"))?;
    Ok(json!({ "action": action, "resource": resource }))
}

async fn task_cmd(server: &str, output: &str, cmd: TaskCmd) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    match cmd {
        TaskCmd::Start {
            principal,
            organization,
            capabilities,
            ttl_seconds,
        } => {
            let caps: Vec<serde_json::Value> = capabilities
                .iter()
                .map(|c| parse_capability(c))
                .collect::<anyhow::Result<_>>()?;
            let body: serde_json::Value = client
                .post(format!("{base}/api/v1/tasks"))
                .json(&json!({
                    "principal_id": principal,
                    "organization_id": organization,
                    "capabilities": caps,
                    "ttl_seconds": ttl_seconds,
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            print_output(output, &body)?;
        }
        TaskCmd::List => {
            let body: serde_json::Value = client
                .get(format!("{base}/api/v1/tasks"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            print_output(output, &body)?;
        }
        TaskCmd::Inspect { id } => {
            let body: serde_json::Value = client
                .get(format!("{base}/api/v1/tasks/{id}"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            print_output(output, &body)?;
        }
        TaskCmd::Capabilities { id } => {
            let body: serde_json::Value = client
                .get(format!("{base}/api/v1/tasks/{id}"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            let out = json!({
                "task_run_id": body.get("task_run_id").cloned().unwrap_or(json!(id)),
                "state_version": body.get("state_version"),
                "capability_ceiling": body.get("capability_ceiling"),
                "current_capabilities": body.get("current_capabilities"),
            });
            print_output(output, &out)?;
        }
        TaskCmd::Terminate {
            id,
            expected_state_version,
        } => {
            let body: serde_json::Value = client
                .post(format!("{base}/api/v1/tasks/{id}/terminate"))
                .json(&json!({
                    "expected_state_version": expected_state_version,
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            print_output(output, &body)?;
        }
    }
    Ok(())
}

async fn intent_cmd(server: &str, output: &str, cmd: IntentCmd) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    match cmd {
        IntentCmd::Create {
            task,
            operation,
            resource,
            audience,
            args,
            expected_state_version,
            idempotency_key,
        } => {
            let arguments: serde_json::Value = serde_json::from_str(&args)
                .map_err(|e| anyhow::anyhow!("invalid --args JSON: {e}"))?;
            let state_version = match expected_state_version {
                Some(v) => v,
                None => {
                    let status: serde_json::Value = client
                        .get(format!("{base}/api/v1/tasks/{task}"))
                        .send()
                        .await?
                        .error_for_status()?
                        .json()
                        .await?;
                    status
                        .get("state_version")
                        .and_then(|v| v.as_u64())
                        .ok_or_else(|| anyhow::anyhow!("task missing state_version"))?
                }
            };
            let body: serde_json::Value = client
                .post(format!("{base}/api/v1/tasks/intents"))
                .json(&json!({
                    "task_run_id": task,
                    "expected_state_version": state_version,
                    "operation": operation,
                    "resource": resource,
                    "audience": audience,
                    "arguments": arguments,
                    "idempotency_key": idempotency_key.unwrap_or_else(uuid_v4),
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            print_output(output, &body)?;
        }
    }
    Ok(())
}
