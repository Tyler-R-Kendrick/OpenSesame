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
mod pass_cmds;
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
pub(crate) use pass_cmds::{PassAttachCmd, PassCmd, PassTombCmd};
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
