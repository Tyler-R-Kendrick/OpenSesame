//! Identity commands: who is signed in, and the providers behind that account.
//! Login and logout stay beside this command, the way the app keeps them on
//! the account rather than inside a tab.

use clap::Subcommand;

use super::{AuthCmd, ProviderCmd};

#[derive(Subcommand, Debug)]
pub(crate) enum IdentityArea {
    /// Show whether a session is present.
    Status,
    /// Show the signed-in account.
    Whoami,
    /// Account checks.
    Auth {
        #[command(subcommand)]
        cmd: AuthCmd,
    },
    /// Identity providers.
    Providers {
        #[command(subcommand)]
        cmd: ProviderCmd,
    },
}

pub(crate) async fn run(server: &str, output: &str, cmd: IdentityArea) -> anyhow::Result<()> {
    match cmd {
        IdentityArea::Status => super::status(server).await,
        IdentityArea::Whoami => super::whoami(server).await,
        IdentityArea::Auth {
            cmd: AuthCmd::Doctor,
        } => super::doctor(server).await,
        IdentityArea::Providers { cmd } => super::provider_cmd(server, output, cmd).await,
    }
}
