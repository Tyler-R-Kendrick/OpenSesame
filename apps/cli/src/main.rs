mod attach;
mod bridge;
mod ceremony;
mod configs;
mod dev_run;
mod dev_surrogate;
mod doctor;
mod entry;
mod github;
mod hooks;
mod init_schema;
mod log_sink;
mod pass_otp;
mod pass_protect;
mod password_agent;
mod plugins;
mod plugins_install;
mod private_file;
mod rotate_local;
mod security;
mod serve;
mod session;
mod store;
mod tui;
mod vault_area;
mod vault_crypto;
mod vault_file;
mod vault_migration;
mod vault_relay_sync;
mod vault_secret;
use clap::{Parser, Subcommand, ValueEnum};
use dev_run::{dev_cmd, DevCmd};
use init_schema::init_schema;
use private_file::write_private_new;
use serde_json::json;
use std::path::PathBuf;
#[derive(Parser, Debug)]
#[command(
    name = "opensesame",
    about = "OpenSesame CLI — credentials as capabilities",
    version
)]
pub(crate) struct Cli {
    #[arg(long, global = true, default_value = "json")]
    output: String,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand, Debug)]
enum Commands {
    /// 1Password workflows with verified private writes.
    PasswordAgent(password_agent::Options),
    /// Interactive session and the first-run setup ceremony.
    Session,
    /// Vault: items, exports, and the sealed store.
    Vault {
        #[command(subcommand)]
        cmd: vault_area::VaultArea,
    },
    /// Connector registration ceremonies compiled into this build.
    Ceremony {
        #[command(subcommand)]
        cmd: CeremonyCmd,
    },
    /// Local web-login recipe signing (private key file only).
    Rotate {
        #[command(subcommand)]
        cmd: rotate_local::RotateCmd,
    },
    /// Local project-config secrets (sealed store under the config dir).
    Config {
        #[command(subcommand)]
        cmd: configs::ConfigCmd,
    },
    /// Print native project configuration files.
    ConfigFiles {
        #[arg(long, default_value = ".env.schema")]
        schema: PathBuf,
    },
    /// Local health: sealed store, relay bindings, crypto tools.
    Doctor,
    /// Local breach checks and sealed-store scan (no Host security API).
    Security {
        #[command(subcommand)]
        cmd: security::SecurityCmd,
    },
    /// Browse the local sealed store (names only).
    Tui {
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
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
    /// Local-IPC bridges for foreign password-manager clients (ADR 0053).
    Bridge {
        #[command(subcommand)]
        cmd: bridge::BridgeCmd,
    },
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
    /// Serve the optional vault-relay peer (ADR 0181). Host/daemon APIs are gone.
    Relay {
        #[command(subcommand)]
        cmd: serve::RelayCmd,
    },
    /// Link or run the helper programs this binary also answers as.
    Helpers {
        #[command(subcommand)]
        cmd: entry::HelpersCmd,
    },
    /// Optional plugins installed at runtime, pinned by sha256 (ADR 0150).
    Plugins {
        #[command(subcommand)]
        cmd: plugins::PluginsCmd,
    },
    /// Govern agent loops over agent-hooks/0.1: `OpenSesame` as an interceptor (ADR 0159).
    Hooks {
        #[command(subcommand)]
        cmd: hooks::HooksCmd,
    },
}
#[derive(Subcommand, Debug)]
pub(crate) enum CeremonyCmd {
    /// Every provider a ceremony covers, and how far each one gets.
    List,
    /// One provider in full: the plan, what it may capture, and its proof.
    Show {
        /// A provider id, from `opensesame ceremony list`.
        provider: String,
    },
}
/// Sealed password-store verbs under `opensesame vault pass` (`pass` CLI parity).
#[derive(Subcommand, Debug)]
pub(crate) enum PassCmd {
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
        #[arg(long, default_value_t = opensesame_sealed_store::default_password_length())]
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
        cmd: pass_otp::PassOtpCmd,
    },
    /// Update / rotate secrets (pass-update parity). Prints new secret (human TTY).
    Update {
        #[arg(required = true)]
        names: Vec<String>,
        #[arg(short = 'l', long, default_value_t = opensesame_sealed_store::default_password_length())]
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
        #[arg(short = 'l', long, default_value_t = opensesame_sealed_store::default_password_length())]
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
    /// Root-protection protectors for `.opensesame-key` (human only).
    Protect {
        #[command(subcommand)]
        cmd: pass_protect::PassProtectCmd,
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
pub(crate) enum PassAttachCmd {
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
    /// Replicate attachment ciphertext to a directory (sealed bytes only).
    Sync {
        /// Mounted encrypted volume or other backup directory.
        #[arg(long)]
        to_dir: PathBuf,
        #[arg(long)]
        path: Option<PathBuf>,
        #[arg(long)]
        tomb: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub(crate) enum PassTombCmd {
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

#[derive(Clone, ValueEnum, Debug)]
enum DeliveryModeArg {
    Auto,
    Agent,
    Development,
}

#[derive(Clone, Copy, ValueEnum, Debug)]
enum CompletionShell {
    Bash,
    Zsh,
    Fish,
}

#[tokio::main]
async fn main() {
    log_sink::exit_on_error(real_main().await);
}

async fn real_main() -> anyhow::Result<()> {
    if let Some(code) = entry::by_program_name() {
        std::process::exit(code);
    }
    let cli = session::verb()?;
    serve::init_tracing(&cli.command);
    match cli.command {
        Commands::PasswordAgent(options) => password_agent::execute(options).await?,
        Commands::Session => session::enter()?,
        Commands::Vault { cmd } => vault_area::run(&cli.output, cmd).await?,
        Commands::Ceremony { cmd } => match cmd {
            CeremonyCmd::List => ceremony::cmd_list(&cli.output)?,
            CeremonyCmd::Show { provider } => ceremony::cmd_show(&cli.output, &provider)?,
        },
        Commands::Rotate { cmd } => rotate_local::run(cmd)?,
        Commands::Config { cmd } => configs::run(&cli.output, cmd)?,
        Commands::Doctor => doctor::run(&cli.output)?,
        Commands::Security { cmd } => security::run(&cli.output, cmd).await?,
        Commands::Tui { path, tomb } => {
            tui::run(path.as_deref(), tomb.as_deref())?;
        }
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
        Commands::Bridge { cmd } => bridge::run(cmd).await?,
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
        Commands::Relay { cmd } => serve::relay(cmd).await?,
        Commands::Helpers { cmd } => entry::helpers(cmd)?,
        Commands::Plugins { cmd } => plugins::run(&cli.output, cmd).await?,
        Commands::Hooks { cmd } => hooks::run(cmd).await?,
    }
    Ok(())
}

pub(crate) fn print_output(output: &str, value: &serde_json::Value) -> anyhow::Result<()> {
    if output == "json" {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{value}");
    }
    Ok(())
}

fn completion_script(shell: CompletionShell) -> &'static str {
    match shell {
        CompletionShell::Bash => {
            r#"_opensesame() { COMPREPLY=( $(compgen -W 'password-agent session vault ceremony rotate config config-files doctor security tui completion init bridge dev relay helpers plugins hooks' -- "${COMP_WORDS[COMP_CWORD]}") ); }
complete -F _opensesame opensesame
"#
        }
        CompletionShell::Zsh => {
            r"#compdef opensesame
_arguments '1:command:(password-agent session vault ceremony rotate config config-files doctor security tui completion init bridge dev relay helpers plugins hooks)'
"
        }
        CompletionShell::Fish => {
            r"complete -c opensesame -f -n '__fish_use_subcommand' -a 'password-agent session vault ceremony rotate config config-files doctor security tui completion init bridge dev relay helpers plugins hooks'
"
        }
    }
}

#[cfg(test)]
#[path = "main_tests.rs"]
mod tests;
