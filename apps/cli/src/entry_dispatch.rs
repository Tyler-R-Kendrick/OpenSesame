//! Select one CLI command without keeping every child future in shared dispatch.
use super::dev_run::dev_cmd;
use super::init_schema::init_schema;
use super::{
    access_area, bridge, completion_script, configs, daemon_cmd, doctor, entry, hooks,
    identity_area, login, password_agent, plugins, security, serve, session, session_path, tui,
    vault_area, Commands, DeliveryModeArg,
};
use serde_json::json;

pub(crate) async fn run() -> anyhow::Result<()> {
    if let Some(code) = entry::by_program_name() {
        std::process::exit(code);
    }
    let cli = session::verb()?;
    serve::init_tracing(&cli.command);
    let server = cli.server.as_str();
    let output = cli.output.as_str();
    match cli.command {
        Commands::PasswordAgent(options) => {
            command_future(move || password_agent::execute(options)).await?;
        }
        Commands::Session => session::enter()?,
        Commands::Vault { cmd } => {
            command_future(move || vault_area::run(server, output, cmd)).await?;
        }
        Commands::Access { cmd } => {
            command_future(move || access_area::run(server, output, cmd)).await?;
        }
        Commands::Identity { cmd } => {
            command_future(move || identity_area::run(server, output, cmd)).await?;
        }
        Commands::Login {
            flow,
            no_browser,
            open_browser,
            qr,
            no_qr,
        } => {
            command_future(move || login(server, flow, no_browser, open_browser, qr, no_qr))
                .await?;
        }
        Commands::Logout => {
            let path = session_path()?;
            let _ = std::fs::remove_file(path);
            println!("{}", json!({"status":"logged_out"}));
        }
        Commands::Doctor => command_future(move || doctor(server)).await?,
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
        Commands::Config { cmd } => {
            command_future(move || configs::run(server, output, cmd)).await?;
        }
        Commands::Bridge { cmd } => command_future(move || bridge::run(cmd)).await?,
        Commands::Tui => command_future(move || tui(server)).await?,
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
        Commands::Daemon(args) => command_future(move || daemon_cmd::run(args)).await?,
        Commands::Host { cmd } => command_future(move || serve::host(cmd)).await?,
        Commands::Worker { cmd } => command_future(move || serve::worker(cmd)).await?,
        Commands::Helpers { cmd } => entry::helpers(cmd)?,
        Commands::Plugins { cmd } => command_future(move || plugins::run(output, cmd)).await?,
        Commands::Security { cmd } => {
            command_future(move || security::run(server, output, cmd)).await?;
        }
        Commands::Hooks { cmd } => command_future(move || hooks::run(server, cmd)).await?,
    }
    Ok(())
}

/// Keep child construction in its selected poll function, outside shared dispatch.
#[inline(never)]
pub(super) fn command_future<'a, F, Fut>(
    make: F,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + 'a>>
where
    F: FnOnce() -> Fut + 'a,
    Fut: std::future::Future<Output = anyhow::Result<()>> + 'a,
{
    // The outer state holds only arguments and the boxed child, not every
    // command's inline future. Construct the selected child when polled.
    Box::pin(async move { Box::pin(make()).await })
}
