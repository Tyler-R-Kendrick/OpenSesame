mod attach;
mod bridge;
mod certs;
mod configs;
mod connect;
mod github;
mod providers_native;
mod store;

use clap::{Parser, Subcommand, ValueEnum};
use opensesame_authn::{
    detect_signals_from_env, resolve_login_flow, DevicePollState, DeviceServerStatus, LoginFlow,
    OpenBrowser, WhoAmI,
};
use opensesame_connector_host::providers::{
    crypto_plan, execute_crypto_plan, execute_human_plan, human_plan, CryptoOperation,
    HumanProviderOperation, HumanProviderPlan,
};
use opensesame_domain::DevDeliveryPolicy;
use opensesame_env_spec::{parse_schema_file, resolve_for_delivery, schema_summary};
use serde::Deserialize;
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
    about = "OpenSesame CLI — credentials as capabilities",
    version
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
        /// Print a terminal QR for `verification_uri_complete` (default: on for TTY).
        #[arg(long, default_value = "false")]
        qr: bool,
        /// Suppress the device-login QR even on a TTY.
        #[arg(long, default_value = "false")]
        no_qr: bool,
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
        /// `ConnectionRef` URI (conn://...) or logical name — never a `SecretRef`.
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
    /// Provider catalog and live/readiness probes.
    Provider {
        #[command(subcommand)]
        cmd: ProviderCmd,
    },
    /// Create, attach, and invoke connectors by `service/name`.
    Connect(connect::ConnectArgs),
    /// First-class connection configuration (alias: connector).
    #[command(alias = "connector")]
    Connection {
        #[command(subcommand)]
        cmd: ConnectionCmd,
    },
    /// Explicit human-only provider reads. Never exposed through MCP or agent APIs.
    Secret {
        #[command(subcommand)]
        cmd: SecretCmd,
    },
    /// Acquire or revoke a short-lived credential lease (human CLI only).
    Lease {
        #[command(subcommand)]
        cmd: LeaseCmd,
    },
    /// Encrypt or decrypt files without placing plaintext in argv or stdout.
    Crypto {
        #[command(subcommand)]
        cmd: CryptoCmd,
    },
    /// Push or pull server-blind encrypted blobs.
    Sync {
        #[command(subcommand)]
        cmd: SyncCmd,
    },
    /// Export non-secret native connection configuration.
    Export {
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Import non-secret native connection configuration.
    Import {
        input: PathBuf,
    },
    /// Print native project configuration files.
    ConfigFiles {
        #[arg(long, default_value = ".env.schema")]
        schema: PathBuf,
    },
    /// Generate shell completion on stdout.
    Completion {
        #[arg(value_enum)]
        shell: CompletionShell,
    },
    /// Initialize a native .env.schema without overwriting an existing file.
    Init {
        #[arg(long, default_value = ".env.schema")]
        schema: PathBuf,
    },
    /// Project-config secret store (write-only values; ADR 0052).
    Config {
        #[command(subcommand)]
        cmd: configs::ConfigCmd,
    },
    /// Password-store management (`pass` parity): init, insert, show, ls, …
    #[command(name = "pass")]
    Pass {
        #[command(subcommand)]
        cmd: PassCmd,
    },
    /// Local-IPC bridges for foreign password-manager clients (ADR 0053).
    Bridge {
        #[command(subcommand)]
        cmd: bridge::BridgeCmd,
    },
    /// Interactive provider and connection browser (never reveals material).
    Tui,
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
    /// Issue TLS certificates from the Host private CA (Infisical-style dev certs).
    Cert {
        #[command(subcommand)]
        cmd: CertCmd,
    },
}

#[derive(Subcommand, Debug)]
enum CertCmd {
    /// Print the Host dev CA certificate (trust this for local TLS).
    Ca {
        #[arg(long)]
        out: Option<PathBuf>,
    },
    /// Issue a short-lived leaf certificate (default: localhost / 24h).
    Issue {
        #[arg(long = "cn", default_value = "localhost")]
        common_name: String,
        #[arg(long = "dns")]
        dns: Vec<String>,
        #[arg(long = "ip")]
        ips: Vec<String>,
        #[arg(long = "ttl-hours", default_value = "24")]
        ttl_hours: u64,
        #[arg(long = "out-dir")]
        out_dir: Option<PathBuf>,
        /// Print the private key on stderr / JSON. Human operator only.
        #[arg(long, default_value = "false")]
        reveal: bool,
    },
    /// List issued certificates (metadata only — no private keys).
    Ls,
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
enum ProviderCmd {
    List,
    Test { id: String },
}

#[derive(Subcommand, Debug)]
enum ConnectionCmd {
    List,
    Add {
        #[arg(long)]
        provider: String,
        #[arg(long)]
        name: String,
        /// Non-secret JSON coordinates (region, vault, mount, etc.).
        #[arg(long, default_value = "{}")]
        config: String,
    },
    Update {
        id: String,
        #[arg(long)]
        name: Option<String>,
        /// Replacement non-secret JSON coordinates.
        #[arg(long)]
        config: Option<String>,
    },
    /// Request credential rotation (never returns secrets).
    Rotate {
        id: String,
        #[arg(long)]
        interval: Option<String>,
        #[arg(long)]
        project: Option<String>,
        #[arg(long)]
        execute_now: bool,
    },
    Remove {
        id: String,
    },
}

#[derive(Subcommand, Debug)]
enum SecretCmd {
    Get {
        #[arg(long)]
        connection: String,
        #[arg(long)]
        key: String,
        /// Acknowledge that plaintext will be written to stdout.
        #[arg(long)]
        reveal: bool,
    },
    List {
        #[arg(long)]
        connection: String,
        #[arg(long, default_value = "/")]
        path: String,
    },
}

#[derive(Subcommand, Debug)]
enum LeaseCmd {
    Acquire {
        #[arg(long)]
        connection: String,
        #[arg(long)]
        resource: String,
        /// Acknowledge that lease material will be written to stdout.
        #[arg(long)]
        reveal: bool,
    },
    Revoke {
        #[arg(long)]
        connection: String,
        #[arg(long)]
        lease: String,
    },
}

#[derive(Subcommand, Debug)]
enum CryptoCmd {
    Encrypt {
        #[arg(long)]
        connection: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
    Decrypt {
        #[arg(long)]
        connection: String,
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
    },
}

#[derive(Subcommand, Debug)]
enum SyncCmd {
    /// Upload a JSON array of ciphertext blobs.
    Push { input: PathBuf },
    /// Download ciphertext blobs to a new JSON file.
    Pull {
        output: PathBuf,
        #[arg(long, default_value_t = 0)]
        since_epoch: u64,
        #[arg(long)]
        device: Option<String>,
    },
}

/// Sealed password-store verbs under `opensesame pass` (`pass` CLI parity).
#[derive(Subcommand, Debug)]
enum PassCmd {
    /// Initialize a git-native sealed secret store.
    Init {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long = "recipient", value_name = "RECIPIENT")]
        recipients: Vec<String>,
        #[arg(long, default_value_t = true)]
        git: bool,
        /// Backup remote URL (git `origin`), e.g. a private GitHub repository.
        #[arg(long)]
        remote: Option<String>,
    },
    /// Insert a secret (human only).
    Insert {
        name: String,
        #[arg(long)]
        echo: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Generate and insert a password.
    Generate {
        name: String,
        #[arg(long, default_value_t = 32)]
        length: usize,
        #[arg(long)]
        no_symbols: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Show an entry (requires TTY or `--reveal`).
    Show {
        name: String,
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// List entries.
    Ls {
        prefix: Option<String>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Find entries by name substring.
    Find {
        query: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Remove an entry.
    Rm {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Copy an entry.
    Cp {
        from: String,
        to: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Move an entry.
    Mv {
        from: String,
        to: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Run git in the sealed-store root.
    Git {
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Seal a Pages plaintext path manifest into encrypted store entries.
    Seal {
        /// JSON manifest exported by Pages Settings → "Download store path manifest".
        manifest: PathBuf,
        /// Overwrite entries that already exist in the store.
        #[arg(long)]
        replace: bool,
        /// Overwrite and delete the plaintext manifest after sealing.
        #[arg(long)]
        shred: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Import a `KeePass` (.kdbx) database into the store.
    ImportKdbx {
        /// KDBX 4.x database to read.
        file: PathBuf,
        /// Optional KDBX key file, if the database uses one.
        #[arg(long)]
        keyfile: Option<PathBuf>,
        /// Place imported entries under this store prefix.
        #[arg(long)]
        prefix: Option<String>,
        /// Overwrite store entries that already exist and differ.
        #[arg(long)]
        replace: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Export the store as a `KeePass` (.kdbx) database.
    ExportKdbx {
        /// File to write the database to.
        dest: PathBuf,
        /// Export only entries under this store prefix.
        #[arg(long)]
        prefix: Option<String>,
        /// Required off a TTY: the export is a portable copy of the store.
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Commit and push the store to its backup remote (git `origin`).
    Backup {
        /// Set (or replace) the backup remote before pushing.
        #[arg(long)]
        remote: Option<String>,
        /// Persist auto-push: push after every store mutation from now on.
        #[arg(long)]
        auto_push: Option<bool>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// File attachments stored as sealed, content-addressed chunks.
    Attach {
        #[command(subcommand)]
        cmd: PassAttachCmd,
    },
    /// OTP tokens (pass-otp parity).
    Otp {
        #[command(subcommand)]
        cmd: PassOtpCmd,
    },
    /// Update / rotate secrets (pass-update parity). Prints new secret (human TTY).
    Update {
        #[arg(required = true)]
        names: Vec<String>,
        #[arg(short = 'l', long, default_value_t = 32)]
        length: usize,
        #[arg(short = 'a', long)]
        auto_length: bool,
        #[arg(short = 'n', long)]
        no_symbols: bool,
        #[arg(short = 'p', long)]
        provide: bool,
        #[arg(short = 'm', long)]
        multiline: bool,
        #[arg(short = 'i', long)]
        include: Option<String>,
        #[arg(short = 'e', long)]
        exclude: Option<String>,
        #[arg(short = 'f', long)]
        force: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Rotate first-line secrets without printing plaintext unless `--reveal`.
    Rotate {
        #[arg(required = true)]
        names: Vec<String>,
        #[arg(short = 'l', long, default_value_t = 32)]
        length: usize,
        #[arg(short = 'a', long)]
        auto_length: bool,
        #[arg(short = 'n', long)]
        no_symbols: bool,
        #[arg(short = 'p', long)]
        provide: bool,
        #[arg(short = 'm', long)]
        multiline: bool,
        #[arg(short = 'i', long)]
        include: Option<String>,
        #[arg(short = 'e', long)]
        exclude: Option<String>,
        #[arg(short = 'f', long)]
        force: bool,
        /// Print the new secret (TTY / human only — never for agents).
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Show an entry's git history: sha, timestamp, subject (metadata only).
    History {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Restore an entry's content from a past commit as a NEW commit.
    Restore {
        name: String,
        /// Commit sha from `pass history`.
        #[arg(long)]
        rev: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Multi-tomb registry.
    Tomb {
        #[command(subcommand)]
        cmd: PassTombCmd,
    },
    /// Open active / named tomb (Linux Tomb mount when applicable).
    Open { name: Option<String> },
    /// Close active / named tomb.
    Close { name: Option<String> },
}

#[derive(Subcommand, Debug)]
enum PassOtpCmd {
    /// Generate a TOTP code.
    Code {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Insert a new OTP entry from an otpauth URI.
    Insert {
        name: Option<String>,
        #[arg(short, long)]
        force: bool,
        #[arg(short, long)]
        echo: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Append / replace otpauth URI on an existing entry.
    Append {
        name: String,
        #[arg(short, long)]
        force: bool,
        #[arg(short, long)]
        echo: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Show the stored otpauth URI.
    Uri {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Validate an otpauth URI.
    Validate { uri: String },
}

#[derive(Subcommand, Debug)]
enum PassAttachCmd {
    /// Seal a file into the store as chunked ciphertext.
    Add {
        /// Logical store path to file the attachment under.
        name: String,
        /// File to attach. Must be a regular file: its length fixes the chunk
        /// count, which is bound into every chunk.
        file: PathBuf,
        /// Content type. Defaults to a guess from the file extension.
        #[arg(long)]
        mime: Option<String>,
        /// Replace an attachment already stored at this path.
        #[arg(long)]
        force: bool,
        /// Overwrite and delete the source file after sealing.
        #[arg(long)]
        shred: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Reassemble an attachment. Plaintext output, so it is reveal-gated.
    Get {
        name: String,
        /// Write to this file instead of stdout.
        #[arg(long)]
        out: Option<PathBuf>,
        /// Required when stdin is not a TTY.
        #[arg(long)]
        reveal: bool,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// List stored attachments. Metadata only, never bytes.
    Ls {
        prefix: Option<String>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Remove an attachment's manifest and reclaim its chunks.
    Rm {
        name: String,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Reclaim chunk objects no manifest references.
    Gc {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
    /// Replicate attachment ciphertext to a configured target.
    ///
    /// The Host API base URL comes from the global `--server`, so this verb
    /// honours `OPENSESAME_SERVER` like every other authenticated command.
    Sync {
        /// Copy ciphertext into this directory instead of using a connector.
        /// Point it at a mounted encrypted volume.
        #[arg(long)]
        to_dir: Option<PathBuf>,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
enum PassTombCmd {
    List,
    Add {
        name: String,
        #[arg(long)]
        store: String,
        #[arg(long)]
        key: String,
        #[arg(long)]
        volume: Option<String>,
        #[arg(long)]
        linux: bool,
    },
    Rm {
        name: String,
    },
    Use {
        name: String,
    },
}

#[derive(Deserialize)]
struct CliConnection {
    id: String,
    provider_id: String,
    display_name: String,
    public_config: serde_json::Value,
}

#[derive(Deserialize)]
struct TuiProvider {
    id: String,
    display_name: String,
    support: String,
}

#[derive(Deserialize)]
struct PortableConnection {
    provider_id: String,
    display_name: String,
    #[serde(default)]
    public_config: serde_json::Value,
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
    /// Spend a frozen intent under its task ceiling. The digest names bytes the
    /// Host API already holds, so the call cannot be restated here.
    Invoke {
        #[arg(long = "digest")]
        intent_digest: String,
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

#[derive(Clone, Copy, ValueEnum, Debug)]
enum CompletionShell {
    Bash,
    Zsh,
    Fish,
}

#[tokio::main]
#[expect(
    clippy::too_many_lines,
    reason = "this match is the stable declarative top-level Clap command dispatch catalog"
)]
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
            qr,
            no_qr,
        } => login(&cli.server, flow, no_browser, open_browser, qr, no_qr).await?,
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
            .await?;
        }
        Commands::Receipt {
            cmd: ReceiptCmd::Verify { id },
        } => verify_receipt(&cli.server, &id).await?,
        Commands::Doctor => doctor(&cli.server).await?,
        Commands::Provider { cmd } => provider_cmd(&cli.server, &cli.output, cmd).await?,
        Commands::Connect(args) => connect::run(&cli.server, args).await?,
        Commands::Connection { cmd } => connection_cmd(&cli.server, &cli.output, cmd).await?,
        Commands::Secret { cmd } => secret_cmd(&cli.server, cmd).await?,
        Commands::Lease { cmd } => lease_cmd(&cli.server, cmd).await?,
        Commands::Crypto { cmd } => crypto_cmd(&cli.server, cmd).await?,
        Commands::Sync { cmd } => sync_cmd(&cli.server, cmd).await?,
        Commands::Export { output } => export_connections(&cli.server, output).await?,
        Commands::Import { input } => import_connections(&cli.server, input).await?,
        Commands::ConfigFiles { schema } => {
            println!(
                "{}",
                json!({"config_files": [schema], "format": "env-spec"})
            );
        }
        Commands::Completion { shell } => {
            print!("{}", completion_script(shell));
        }
        Commands::Init { schema } => init_schema(&schema)?,
        Commands::Config { cmd } => configs::run(&cli.server, &cli.output, cmd).await?,
        Commands::Bridge { cmd } => bridge::run(cmd)?,
        Commands::Pass { cmd } => match cmd {
            PassCmd::Init {
                path,
                recipients,
                git,
                remote,
            } => store::cmd_init(path.as_deref(), &recipients, git, remote.as_deref())?,
            PassCmd::Insert {
                name,
                echo,
                path,
                tomb,
            } => store::cmd_insert(&name, echo, path.as_deref(), tomb.as_deref())?,
            PassCmd::Generate {
                name,
                length,
                no_symbols,
                path,
                tomb,
            } => store::cmd_generate(&name, length, no_symbols, path.as_deref(), tomb.as_deref())?,
            PassCmd::Show {
                name,
                reveal,
                path,
                tomb,
            } => store::cmd_show(&name, reveal, path.as_deref(), tomb.as_deref())?,
            PassCmd::Ls { prefix, path, tomb } => {
                store::cmd_ls(prefix.as_deref(), path.as_deref(), tomb.as_deref())?;
            }
            PassCmd::Find { query, path, tomb } => {
                store::cmd_find(&query, path.as_deref(), tomb.as_deref())?;
            }
            PassCmd::Rm { name, path, tomb } => {
                store::cmd_rm(&name, path.as_deref(), tomb.as_deref())?;
            }
            PassCmd::Cp {
                from,
                to,
                path,
                tomb,
            } => store::cmd_cp(&from, &to, path.as_deref(), tomb.as_deref())?,
            PassCmd::Mv {
                from,
                to,
                path,
                tomb,
            } => store::cmd_mv(&from, &to, path.as_deref(), tomb.as_deref())?,
            PassCmd::Git { args, path, tomb } => {
                let code = store::cmd_git(&args, path.as_deref(), tomb.as_deref())?;
                if code != 0 {
                    std::process::exit(code);
                }
            }
            PassCmd::Seal {
                manifest,
                replace,
                shred,
                path,
                tomb,
            } => store::cmd_seal(&manifest, replace, shred, path.as_deref(), tomb.as_deref())?,
            PassCmd::ImportKdbx {
                file,
                keyfile,
                prefix,
                replace,
                path,
                tomb,
            } => store::cmd_import_kdbx(
                &file,
                keyfile,
                prefix,
                replace,
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassCmd::ExportKdbx {
                dest,
                prefix,
                reveal,
                path,
                tomb,
            } => store::cmd_export_kdbx(
                &dest,
                prefix.as_deref(),
                reveal,
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassCmd::Backup {
                remote,
                auto_push,
                path,
                tomb,
            } => {
                store::cmd_backup(remote, auto_push, path.as_deref(), tomb.as_deref()).await?;
            }
            PassCmd::Attach { cmd } => match cmd {
                PassAttachCmd::Add {
                    name,
                    file,
                    mime,
                    force,
                    shred,
                    path,
                    tomb,
                } => attach::cmd_attach_add(
                    &name,
                    &file,
                    mime,
                    force,
                    shred,
                    path.as_deref(),
                    tomb.as_deref(),
                )?,
                PassAttachCmd::Get {
                    name,
                    out,
                    reveal,
                    path,
                    tomb,
                } => attach::cmd_attach_get(
                    &name,
                    out.as_deref(),
                    reveal,
                    path.as_deref(),
                    tomb.as_deref(),
                )?,
                PassAttachCmd::Ls { prefix, path, tomb } => {
                    attach::cmd_attach_ls(prefix.as_deref(), path.as_deref(), tomb.as_deref())?;
                }
                PassAttachCmd::Rm { name, path, tomb } => {
                    attach::cmd_attach_rm(&name, path.as_deref(), tomb.as_deref())?;
                }
                PassAttachCmd::Gc { path, tomb } => {
                    attach::cmd_attach_gc(path.as_deref(), tomb.as_deref())?;
                }
                PassAttachCmd::Sync { to_dir, path, tomb } => {
                    attach::cmd_attach_sync(
                        to_dir.as_deref(),
                        &cli.server,
                        path.as_deref(),
                        tomb.as_deref(),
                    )
                    .await?;
                }
            },
            PassCmd::Otp { cmd } => match cmd {
                PassOtpCmd::Code { name, path, tomb } => {
                    store::cmd_otp_code(&name, path.as_deref(), tomb.as_deref())?;
                }
                PassOtpCmd::Insert {
                    name,
                    force,
                    echo,
                    path,
                    tomb,
                } => store::cmd_otp_insert(name, force, echo, path.as_deref(), tomb.as_deref())?,
                PassOtpCmd::Append {
                    name,
                    force,
                    echo,
                    path,
                    tomb,
                } => store::cmd_otp_append(&name, force, echo, path.as_deref(), tomb.as_deref())?,
                PassOtpCmd::Uri { name, path, tomb } => {
                    store::cmd_otp_uri(&name, path.as_deref(), tomb.as_deref())?;
                }
                PassOtpCmd::Validate { uri } => store::cmd_otp_validate(&uri)?,
            },
            PassCmd::Update {
                names,
                length,
                auto_length,
                no_symbols,
                provide,
                multiline,
                include,
                exclude,
                force,
                path,
                tomb,
            } => store::cmd_update(
                &names,
                &store::UpdateCliOpts {
                    length,
                    auto_length,
                    no_symbols,
                    provide,
                    multiline,
                    include,
                    exclude,
                    force,
                },
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassCmd::Rotate {
                names,
                length,
                auto_length,
                no_symbols,
                provide,
                multiline,
                include,
                exclude,
                force,
                reveal,
                path,
                tomb,
            } => store::cmd_rotate(
                &names,
                &store::UpdateCliOpts {
                    length,
                    auto_length,
                    no_symbols,
                    provide,
                    multiline,
                    include,
                    exclude,
                    force,
                },
                reveal,
                path.as_deref(),
                tomb.as_deref(),
            )?,
            PassCmd::History { name, path, tomb } => {
                store::cmd_history(&name, path.as_deref(), tomb.as_deref())?;
            }
            PassCmd::Restore {
                name,
                rev,
                path,
                tomb,
            } => store::cmd_restore(&name, &rev, path.as_deref(), tomb.as_deref())?,
            PassCmd::Tomb { cmd } => match cmd {
                PassTombCmd::List => store::cmd_tomb_list()?,
                PassTombCmd::Add {
                    name,
                    store: store_path,
                    key,
                    volume,
                    linux,
                } => store::cmd_tomb_add(&name, store_path, key, volume, linux)?,
                PassTombCmd::Rm { name } => store::cmd_tomb_rm(&name)?,
                PassTombCmd::Use { name } => store::cmd_tomb_use(&name)?,
            },
            PassCmd::Open { name } => store::cmd_open(name.as_deref())?,
            PassCmd::Close { name } => store::cmd_close(name.as_deref())?,
        },
        Commands::Tui => tui(&cli.server).await?,
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
            dev_cmd(cmd, agent, &schema)?;
        }
        Commands::Daemon { url, cmd } => daemon_cmd(&url, cmd).await?,
        Commands::Task { cmd } => task_cmd(&cli.server, &cli.output, cmd).await?,
        Commands::Intent { cmd } => intent_cmd(&cli.server, &cli.output, cmd).await?,
        Commands::Cert { cmd } => match cmd {
            CertCmd::Ca { out } => certs::cmd_ca(&cli.server, &cli.output, out).await?,
            CertCmd::Issue {
                common_name,
                dns,
                ips,
                ttl_hours,
                out_dir,
                reveal,
            } => {
                certs::cmd_issue(
                    &cli.server,
                    &cli.output,
                    common_name,
                    dns,
                    ips,
                    ttl_hours,
                    out_dir,
                    reveal,
                )
                .await?;
            }
            CertCmd::Ls => certs::cmd_ls(&cli.server, &cli.output).await?,
        },
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
            let installed = install_daemon_binary(&home, &dest);
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
        DaemonCmd::Logs => {
            if let Ok(content) = std::fs::read_to_string(&logfile) {
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
        }
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

fn install_daemon_binary(home: &str, dest: &str) -> bool {
    let source = [
        "target/debug/opensesame-daemon",
        "target/release/opensesame-daemon",
    ]
    .into_iter()
    .find(|candidate| PathBuf::from(candidate).exists());
    let Some(source) = source else {
        return false;
    };
    let _ = std::fs::create_dir_all(format!("{home}/.local/bin"));
    if std::fs::copy(source, dest).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755));
    }
    true
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
    match StdCommand::new("opensesame-daemon")
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
                "hint": "build with: cargo build -p opensesame-daemon"
            })
        ),
    }
}

fn dev_cmd(cmd: DevCmd, agent: bool, schema: &std::path::Path) -> anyhow::Result<()> {
    match cmd {
        DevCmd::Check => {
            let doc = parse_schema_file(schema)
                .map_err(|e| anyhow::anyhow!("env-spec parse failed: {e}"))?;
            let summary = schema_summary(&doc);
            println!("{}", serde_json::to_string_pretty(&summary)?);
        }
        DevCmd::Resolve => {
            let doc = parse_schema_file(schema)
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
            let doc = parse_schema_file(schema)
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
            for e in entries.iter().filter(|entry| !entry.omitted) {
                if let Some(v) = &e.env_value {
                    child.env(&e.key, v);
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

/// Write a file only its owner can read, without a moment where it is anything else.
///
/// `fs::write` then `set_permissions` creates the file at the umask's mode first,
/// so a token spends a window world-readable — long enough for another account on
/// the box to open it and keep the handle.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // An existing file keeps its old mode, so say it again.
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn write_private_new(path: &std::path::Path, bytes: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)?;
    Ok(())
}

fn session_path() -> anyhow::Result<PathBuf> {
    let dir = directories::ProjectDirs::from("dev", "OpenSesame", "opensesame")
        .ok_or_else(|| anyhow::anyhow!("no project dirs"))?;
    let path = dir.config_dir().join("session.json");
    std::fs::create_dir_all(dir.config_dir())?;
    Ok(path)
}

pub(crate) fn load_access_token() -> anyhow::Result<String> {
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

/// Default device-code lifetime, and the most a server may ask for.
const DEVICE_CODE_TTL_SECS: i64 = 900;
const MAX_DEVICE_CODE_TTL_SECS: i64 = 3600;

fn operator_token() -> String {
    env::var("OPENSESAME_OPERATOR_TOKEN").unwrap_or_else(|_| "opensesame-dev-operator".into())
}

async fn login(
    server: &str,
    flow: FlowArg,
    no_browser: bool,
    open_browser: OpenBrowserArg,
    qr: bool,
    no_qr: bool,
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

    let show_qr = if no_qr {
        false
    } else if qr {
        true
    } else {
        std::io::IsTerminal::is_terminal(&std::io::stdout())
    };

    match selected {
        LoginFlow::Device | LoginFlow::Auto => device_login(server, show_qr).await?,
        LoginFlow::Loopback => {
            eprintln!("loopback PKCE selected; falling back to device when no external IdP configured in local profile");
            device_login(server, show_qr).await?;
        }
        LoginFlow::Ciba => anyhow::bail!("CIBA not enabled by issuer profile"),
        LoginFlow::Workload => {
            anyhow::bail!("configure OPENSESAME_WORKLOAD_IDENTITY for workload flow")
        }
    }
    Ok(())
}

async fn device_login(server: &str, show_qr: bool) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let auth: serde_json::Value = client
        .post(format!("{server}/api/v1/device/authorize"))
        .json(&json!({"client_id":"opensesame-cli","scope":"opensesame.session"}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    let field = |name: &str| -> anyhow::Result<String> {
        auth[name]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow::anyhow!("device authorize response missing {name}"))
    };
    let device_code = field("device_code")?;
    let user_code = field("user_code")?;
    let verification_uri = field("verification_uri")?;
    let verification_uri_complete = auth["verification_uri_complete"]
        .as_str()
        .map(str::to_string);
    let interval = auth["interval"].as_u64().unwrap_or(5).clamp(1, 60);
    // The server chooses this number. Clamped, because chrono answers an
    // out-of-range second count with a panic rather than an error.
    let expires_in = auth["expires_in"]
        .as_i64()
        .unwrap_or(DEVICE_CODE_TTL_SECS)
        .clamp(1, MAX_DEVICE_CODE_TTL_SECS);

    // Never print device_code
    println!("Shortcode: {user_code}");
    println!("Open {verification_uri} and enter the shortcode above.");
    if let Some(ref complete) = verification_uri_complete {
        println!("Or open: {complete}");
    }
    if show_qr {
        let scan = verification_uri_complete
            .as_deref()
            .unwrap_or(verification_uri.as_str());
        if let Err(err) = qr2term::print_qr(scan) {
            eprintln!("(QR unavailable: {err})");
        }
    }
    println!(
        "If that page asks for a passkey, this terminal is not your phone or YubiKey. Use TOTP, email, or approve on your phone, then return here."
    );
    let approve_body = serde_json::json!({"user_code": user_code});
    // The operator token is a shared secret for this machine. Printing it puts it in
    // terminal scrollback, CI logs, and whatever collects those; name the variable
    // instead and let the shell read it.
    println!(
        "(Or approve via: curl -s -X POST {server}/api/v1/device/approve -H 'content-type: application/json' -H \"x-opensesame-operator: $OPENSESAME_OPERATOR_TOKEN\" -d '{approve_body}')"
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
                "client_id": "opensesame-cli",
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
                Err(
                    opensesame_authn::DeviceFlowError::AuthorizationPending
                    | opensesame_authn::DeviceFlowError::SlowDown,
                ) => {}
                Err(e) => return Err(e.into()),
                Ok(_) => unreachable!(),
            }
        } else {
            complete_device_login(&body)?;
            let _ = state.next_action(chrono::Utc::now(), DeviceServerStatus::Success);
            break;
        }
    }
    Ok(())
}

fn complete_device_login(body: &serde_json::Value) -> anyhow::Result<()> {
    let mut session = body
        .get("session")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("missing session metadata"))?;
    if let (Some(access_token), Some(object)) =
        (body.get("access_token").cloned(), session.as_object_mut())
    {
        object.insert("access_token".into(), access_token);
    }
    // Persist opaque session metadata only — no refresh token field expected.
    let path = session_path()?;
    write_private(&path, &serde_json::to_vec_pretty(&session)?)?;
    // Say that the session exists without putting tokens into scrollback or logs.
    println!(
        "{}",
        json!({"status":"logged_in","session": redact_session_tokens(session)})
    );
    Ok(())
}

fn redact_session_tokens(mut session: serde_json::Value) -> serde_json::Value {
    let Some(object) = session.as_object_mut() else {
        return session;
    };
    for key in ["access_token", "refresh_token", "id_token"] {
        if let Some(value) = object.get_mut(key) {
            *value = json!("[redacted]");
        }
    }
    session
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

async fn provider_cmd(server: &str, output: &str, cmd: ProviderCmd) -> anyhow::Result<()> {
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    let value: serde_json::Value = match cmd {
        ProviderCmd::List => {
            client
                .get(format!("{base}/api/v1/providers"))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ProviderCmd::Test { id } => {
            let token = load_access_token()?;
            client
                .post(format!("{base}/api/v1/providers/{id}/test"))
                .bearer_auth(token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
    };
    print_output(output, &value)
}

async fn connection_cmd(server: &str, output: &str, cmd: ConnectionCmd) -> anyhow::Result<()> {
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    let value = match cmd {
        ConnectionCmd::List => {
            client
                .get(format!("{base}/api/v1/connections"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConnectionCmd::Add {
            provider,
            name,
            config,
        } => {
            let public_config: serde_json::Value = serde_json::from_str(&config)?;
            client
                .post(format!("{base}/api/v1/connections"))
                .bearer_auth(&token)
                .json(&json!({
                    "provider_id": provider,
                    "display_name": name,
                    "public_config": public_config,
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConnectionCmd::Update { id, name, config } => {
            let public_config = config
                .map(|value| serde_json::from_str::<serde_json::Value>(&value))
                .transpose()?;
            client
                .put(format!("{base}/api/v1/connections/{id}"))
                .bearer_auth(&token)
                .json(&json!({
                    "display_name": name,
                    "public_config": public_config,
                }))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?
        }
        ConnectionCmd::Rotate {
            id,
            interval,
            project,
            execute_now,
        } => {
            let mut body = json!({
                "connection_id": id,
                "execute_now": execute_now,
            });
            if let Some(interval) = interval {
                body["interval"] = json!(interval);
            }
            if let Some(project) = project {
                body["project_id"] = json!(project);
            }
            let result: serde_json::Value = client
                .post(format!("{base}/api/v1/rotations"))
                .bearer_auth(&token)
                .json(&body)
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            refuse_rotation_secret_fields(&result)?;
            result
        }
        ConnectionCmd::Remove { id } => {
            client
                .delete(format!("{base}/api/v1/connections/{id}"))
                .bearer_auth(&token)
                .send()
                .await?
                .error_for_status()?;
            json!({"removed": id})
        }
    };
    print_output(output, &value)
}

fn refuse_rotation_secret_fields(result: &serde_json::Value) -> anyhow::Result<()> {
    for forbidden in [
        "secret",
        "password",
        "token",
        "access_token",
        "refresh_token",
        "api_key",
        "value",
    ] {
        if result.get(forbidden).is_some() {
            anyhow::bail!("Host rotation response unexpectedly included `{forbidden}`");
        }
    }
    Ok(())
}

async fn secret_cmd(server: &str, cmd: SecretCmd) -> anyhow::Result<()> {
    let (connection_id, operation, resource, reveal) = match cmd {
        SecretCmd::Get {
            connection,
            key,
            reveal,
        } => (connection, HumanProviderOperation::Read, key, reveal),
        SecretCmd::List { connection, path } => {
            (connection, HumanProviderOperation::List, path, true)
        }
    };
    if operation == HumanProviderOperation::Read && !reveal {
        anyhow::bail!("plaintext output requires --reveal; agents must use ConnectionRef invoke");
    }
    execute_connection_provider(server, &connection_id, operation, &resource).await
}

async fn lease_cmd(server: &str, cmd: LeaseCmd) -> anyhow::Result<()> {
    let (connection, operation, resource) = match cmd {
        LeaseCmd::Acquire {
            connection,
            resource,
            reveal,
        } => {
            if !reveal {
                anyhow::bail!(
                    "lease output requires --reveal; agents must use ConnectionRef invoke"
                );
            }
            (connection, HumanProviderOperation::Lease, resource)
        }
        LeaseCmd::Revoke { connection, lease } => {
            (connection, HumanProviderOperation::Revoke, lease)
        }
    };
    execute_connection_provider(server, &connection, operation, &resource).await
}

async fn execute_connection_provider(
    server: &str,
    connection_id: &str,
    operation: HumanProviderOperation,
    resource: &str,
) -> anyhow::Result<()> {
    let connection = load_cli_connection(server, connection_id).await?;
    let plan = human_plan(
        &connection.provider_id,
        operation,
        resource,
        &connection.public_config,
    )?;
    // GitHub App leases are minted natively: RS256 signing and the GitHub API
    // call live here in the human CLI, so connector-host never holds a token.
    if let HumanProviderPlan::GitHubApp {
        app_id,
        installation_id,
        private_key_path,
    } = plan
    {
        let config = github::GitHubAppConfig::resolve(app_id, installation_id, private_key_path)?;
        let minted = github::mint_installation_token(&config).await?;
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "provider": "github-app",
                "token_type": "token",
                "token": minted.token,
                "expires_at": minted.expires_at,
            }))?
        );
        return Ok(());
    }
    // Bitwarden/Vaultwarden reads need an async HTTP client and a TTY
    // password ceremony, so the sync executor refuses their plan and the
    // native call site performs it here -- the GitHubApp split above.
    if let Some(rendered) = providers_native::execute_native_plan(&plan).await? {
        println!("{rendered}");
        return Ok(());
    }
    println!("{}", execute_human_plan(plan)?);
    Ok(())
}

async fn crypto_cmd(server: &str, cmd: CryptoCmd) -> anyhow::Result<()> {
    let (connection_id, operation, input, output) = match cmd {
        CryptoCmd::Encrypt {
            connection,
            input,
            output,
        } => (connection, CryptoOperation::Encrypt, input, output),
        CryptoCmd::Decrypt {
            connection,
            input,
            output,
        } => (connection, CryptoOperation::Decrypt, input, output),
    };
    let connection = load_cli_connection(server, &connection_id).await?;
    execute_crypto_plan(crypto_plan(
        &connection.provider_id,
        operation,
        &input,
        &output,
        &connection.public_config,
    )?)?;
    println!(
        "{}",
        json!({"written": output, "provider": connection.provider_id})
    );
    Ok(())
}

async fn sync_cmd(server: &str, cmd: SyncCmd) -> anyhow::Result<()> {
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    match cmd {
        SyncCmd::Push { input } => {
            let value: serde_json::Value = serde_json::from_slice(&read_bounded(&input)?)?;
            let blobs = value
                .as_array()
                .cloned()
                .or_else(|| value.get("blobs").and_then(|v| v.as_array()).cloned())
                .ok_or_else(|| {
                    anyhow::anyhow!("sync input must be a JSON array of ciphertext blobs")
                })?;
            let response: serde_json::Value = client
                .post(format!("{base}/api/v1/sync/push"))
                .bearer_auth(token)
                .json(&json!({"blobs": blobs}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            println!("{}", serde_json::to_string_pretty(&response)?);
        }
        SyncCmd::Pull {
            output,
            since_epoch,
            device,
        } => {
            let response: serde_json::Value = client
                .post(format!("{base}/api/v1/sync/pull"))
                .bearer_auth(token)
                .json(&json!({"since_epoch": since_epoch, "device_id": device}))
                .send()
                .await?
                .error_for_status()?
                .json()
                .await?;
            write_private_new(&output, serde_json::to_vec_pretty(&response)?.as_slice())?;
            println!("{}", json!({"written": output, "plaintext": false}));
        }
    }
    Ok(())
}

async fn export_connections(server: &str, output: Option<PathBuf>) -> anyhow::Result<()> {
    let token = load_access_token()?;
    let value: serde_json::Value = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/connections",
            server.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let portable = json!({
        "schema_version": 1,
        "format": "opensesame-native-connections",
        "connections": value.get("connections").cloned().unwrap_or_default(),
    });
    if let Some(path) = output {
        write_private_new(&path, serde_json::to_vec_pretty(&portable)?.as_slice())?;
        println!("{}", json!({"written": path}));
    } else {
        println!("{}", serde_json::to_string_pretty(&portable)?);
    }
    Ok(())
}

async fn import_connections(server: &str, input: PathBuf) -> anyhow::Result<()> {
    let value: serde_json::Value = serde_json::from_slice(&read_bounded(&input)?)?;
    let connections: Vec<PortableConnection> = serde_json::from_value(
        value
            .get("connections")
            .cloned()
            .unwrap_or_else(|| value.clone()),
    )?;
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/connections", server.trim_end_matches('/'));
    let mut imported = Vec::with_capacity(connections.len());
    for connection in connections {
        let created: serde_json::Value = client
            .post(&url)
            .bearer_auth(&token)
            .json(&json!({
                "provider_id": connection.provider_id,
                "display_name": connection.display_name,
                "public_config": connection.public_config,
            }))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        imported.push(created);
    }
    println!(
        "{}",
        json!({"imported": imported.len(), "connections": imported})
    );
    Ok(())
}

fn init_schema(path: &std::path::Path) -> anyhow::Result<()> {
    const TEMPLATE: &[u8] = b"# @defaultSensitive=true\n# Native OpenSesame project contract. Add public defaults explicitly.\n";
    write_private_new(path, TEMPLATE)?;
    println!("{}", json!({"initialized": path, "format": "env-spec"}));
    Ok(())
}

fn completion_script(shell: CompletionShell) -> &'static str {
    match shell {
        CompletionShell::Bash => {
            r#"_opensesame() { COMPREPLY=( $(compgen -W 'login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert' -- "${COMP_WORDS[COMP_CWORD]}") ); }
complete -F _opensesame opensesame
"#
        }
        CompletionShell::Zsh => {
            r"#compdef opensesame
_arguments '1:command:(login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert)'
"
        }
        CompletionShell::Fish => {
            r"complete -c opensesame -f -n '__fish_use_subcommand' -a 'login logout status whoami auth invoke receipt doctor provider connect connection connector secret lease crypto sync export import config-files completion init config pass tui dev daemon task intent cert'
"
        }
    }
}

fn read_bounded(path: &std::path::Path) -> anyhow::Result<Vec<u8>> {
    const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
    if std::fs::metadata(path)?.len() > MAX_CONFIG_BYTES {
        anyhow::bail!("input exceeds 16 MiB");
    }
    Ok(std::fs::read(path)?)
}

async fn load_cli_connection(server: &str, connection_id: &str) -> anyhow::Result<CliConnection> {
    let token = load_access_token()?;
    let body: serde_json::Value = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/connections",
            server.trim_end_matches('/')
        ))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let connections: Vec<CliConnection> =
        serde_json::from_value(body.get("connections").cloned().unwrap_or_default())?;
    connections
        .into_iter()
        .find(|connection| connection.id == connection_id)
        .ok_or_else(|| anyhow::anyhow!("connection {connection_id} not found"))
}

async fn tui(server: &str) -> anyhow::Result<()> {
    let token = load_access_token()?;
    let client = reqwest::Client::new();
    let base = server.trim_end_matches('/');
    let provider_body: serde_json::Value = client
        .get(format!("{base}/api/v1/providers"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let connection_body: serde_json::Value = client
        .get(format!("{base}/api/v1/connections"))
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let providers: Vec<TuiProvider> =
        serde_json::from_value(provider_body.get("providers").cloned().unwrap_or_default())?;
    let connections: Vec<CliConnection> = serde_json::from_value(
        connection_body
            .get("connections")
            .cloned()
            .unwrap_or_default(),
    )?;
    run_tui(&providers, &connections)
}

fn run_tui(providers: &[TuiProvider], connections: &[CliConnection]) -> anyhow::Result<()> {
    use crossterm::{
        execute,
        terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
    };
    use ratatui::{backend::CrosstermBackend, Terminal};
    use std::io::stdout;

    enable_raw_mode()?;
    let mut output = stdout();
    execute!(output, EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(output))?;
    let result = (|| -> anyhow::Result<()> {
        loop {
            terminal.draw(|frame| draw_tui(frame, providers, connections))?;
            if tui_quit_requested()? {
                break;
            }
        }
        Ok(())
    })();
    disable_raw_mode()?;
    execute!(terminal.backend_mut(), LeaveAlternateScreen)?;
    terminal.show_cursor()?;
    result
}

fn tui_quit_requested() -> anyhow::Result<bool> {
    use crossterm::event::{self, Event, KeyCode, KeyEventKind};
    if !event::poll(Duration::from_millis(250))? {
        return Ok(false);
    }
    let Event::Key(key) = event::read()? else {
        return Ok(false);
    };
    Ok(key.kind == KeyEventKind::Press && matches!(key.code, KeyCode::Char('q') | KeyCode::Esc))
}

fn draw_tui(
    frame: &mut ratatui::Frame<'_>,
    providers: &[TuiProvider],
    connections: &[CliConnection],
) {
    use ratatui::{
        layout::{Constraint, Layout},
        style::{Color, Style},
        widgets::{Block, Borders, List, Paragraph},
    };
    let [header, body, footer] = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(4),
        Constraint::Length(2),
    ])
    .areas(frame.area());
    let [left, right] =
        Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(body);
    frame.render_widget(
        Paragraph::new("OpenSesame connectors")
            .style(Style::default().fg(Color::Cyan))
            .block(Block::default().borders(Borders::ALL)),
        header,
    );
    frame.render_widget(
        List::new(providers.iter().map(|provider| {
            format!(
                "{}  {}  [{}]",
                provider.id, provider.display_name, provider.support
            )
        }))
        .block(Block::default().title("Providers").borders(Borders::ALL)),
        left,
    );
    frame.render_widget(
        List::new(connections.iter().map(|connection| {
            format!(
                "{}  {}  ({})",
                connection.display_name, connection.provider_id, connection.id
            )
        }))
        .block(Block::default().title("Connections").borders(Borders::ALL)),
        right,
    );
    frame.render_widget(
        Paragraph::new("q or Esc: quit · material is never displayed"),
        footer,
    );
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
    let op = operator_token();
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
                .header("authorization", format!("Bearer operator:{op}"))
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
                .header("authorization", format!("Bearer operator:{op}"))
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
                .header("authorization", format!("Bearer operator:{op}"))
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
                .header("authorization", format!("Bearer operator:{op}"))
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
                .header("authorization", format!("Bearer operator:{op}"))
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
    let op = operator_token();
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
            let state_version = if let Some(v) = expected_state_version {
                v
            } else {
                let status: serde_json::Value = client
                    .get(format!("{base}/api/v1/tasks/{task}"))
                    .header("authorization", format!("Bearer operator:{op}"))
                    .send()
                    .await?
                    .error_for_status()?
                    .json()
                    .await?;
                status
                    .get("state_version")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| anyhow::anyhow!("task missing state_version"))?
            };
            let body: serde_json::Value = client
                .post(format!("{base}/api/v1/tasks/intents"))
                .header("authorization", format!("Bearer operator:{op}"))
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
        IntentCmd::Invoke { intent_digest } => {
            let body: serde_json::Value = client
                .post(format!("{base}/api/v1/tasks/invoke"))
                .header("authorization", format!("Bearer operator:{op}"))
                .json(&json!({ "intent_digest": intent_digest }))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tui_renders_metadata_without_public_config() {
        use ratatui::{backend::TestBackend, Terminal};
        let providers = vec![TuiProvider {
            id: "plain".into(),
            display_name: "Plain environment".into(),
            support: "contract_tested".into(),
        }];
        let connections = vec![CliConnection {
            id: "connection_1".into(),
            provider_id: "plain".into(),
            display_name: "Demo".into(),
            public_config: json!({"path": "must-not-render"}),
        }];
        let mut terminal = Terminal::new(TestBackend::new(100, 12)).unwrap();
        terminal
            .draw(|frame| draw_tui(frame, &providers, &connections))
            .unwrap();
        let buffer = terminal.backend().buffer();
        let rendered: String = (0..buffer.area.height)
            .flat_map(|y| (0..buffer.area.width).map(move |x| buffer[(x, y)].symbol().to_owned()))
            .collect();
        assert!(rendered.contains("Plain environment"));
        assert!(rendered.contains("Demo"));
        assert!(!rendered.contains("must-not-render"));
    }

    #[test]
    fn a_written_session_is_never_readable_by_anyone_else() {
        let dir = std::env::temp_dir().join(format!("opensesame-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.json");

        // Left behind by an earlier version at a wider mode.
        std::fs::write(&path, b"{}").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        }

        write_private(&path, b"{\"access_token\":\"at\"}").unwrap();
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"access_token\":\"at\"}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "mode was {mode:o}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_server_cannot_choose_an_unbounded_device_code_lifetime() {
        for (given, expected) in [
            (600_i64, 600_i64),
            (0, 1),
            (-5, 1),
            (i64::MAX, MAX_DEVICE_CODE_TTL_SECS),
        ] {
            assert_eq!(given.clamp(1, MAX_DEVICE_CODE_TTL_SECS), expected);
        }
        // The clamp is what keeps this out of chrono, which panics rather than errors.
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let refused = std::panic::catch_unwind(|| chrono::Duration::seconds(i64::MAX)).is_err();
        std::panic::set_hook(hook);
        assert!(refused);
    }

    /// `--output` is a *global* option, so a subcommand field of the same name
    /// silently claims the same clap arg id and the parser panics at runtime
    /// rather than failing to compile. Parsing is the only thing that catches
    /// it, so pin every `pass` verb that takes a file argument.
    #[test]
    fn pass_kdbx_verbs_parse_without_colliding_with_the_global_output_option() {
        use clap::Parser;

        let cli = Cli::parse_from([
            "opensesame",
            "pass",
            "export-kdbx",
            "/tmp/vault.kdbx",
            "--reveal",
        ]);
        let Commands::Pass {
            cmd: PassCmd::ExportKdbx { dest, reveal, .. },
        } = cli.command
        else {
            panic!("expected pass export-kdbx");
        };
        assert_eq!(dest, PathBuf::from("/tmp/vault.kdbx"));
        assert!(reveal);

        let cli = Cli::parse_from([
            "opensesame",
            "pass",
            "import-kdbx",
            "/tmp/vault.kdbx",
            "--keyfile",
            "/tmp/vault.key",
            "--prefix",
            "Imported",
            "--replace",
        ]);
        let Commands::Pass {
            cmd:
                PassCmd::ImportKdbx {
                    file,
                    keyfile,
                    prefix,
                    replace,
                    ..
                },
        } = cli.command
        else {
            panic!("expected pass import-kdbx");
        };
        assert_eq!(file, PathBuf::from("/tmp/vault.kdbx"));
        assert_eq!(keyfile, Some(PathBuf::from("/tmp/vault.key")));
        assert_eq!(prefix.as_deref(), Some("Imported"));
        assert!(replace);
    }

    /// The whole `pass` tree must keep parsing; `debug_assert` walks every
    /// subcommand and catches id collisions the tests above cannot enumerate.
    #[test]
    fn the_command_tree_has_no_conflicting_argument_ids() {
        use clap::CommandFactory;
        Cli::command().debug_assert();
    }
}
