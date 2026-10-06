//! OS credential-store backed service-account lifecycle.
use super::{io, Source};
use clap::Subcommand;
use serde_json::json;
#[derive(Subcommand, Debug)]
pub(crate) enum Service {
    Connect {
        #[command(flatten)]
        source: Source,
        #[arg(long, default_value = "OpenSesame Automation")]
        name: String,
    },
    Status,
    #[command(alias = "remove")]
    Forget,
    Setup(super::setup::Options),
    Recover {
        #[arg(long, default_value = "OpenSesame Automation")]
        name: String,
    },
}
pub(super) use super::credential::load;
pub(super) fn run(cmd: Service) -> anyhow::Result<()> {
    match cmd {
        Service::Connect { source, name } => {
            anyhow::ensure!(!name.trim().is_empty(), "Account name required");
            super::credential::require_empty()?;
            let raw = io::private_input(&source)?;
            let token = opensesame_connector_host::password_agent::service::token(&raw)?;
            let vaults = super::setup::visible(token)?;
            super::credential::save(token)?;
            super::credential::save_settings(&json!({"name":name.trim()}))?;
            let safe: Vec<_> = vaults
                .iter()
                .map(|v| json!({"id":v["id"],"name":v["name"]}))
                .collect();
            super::print(
                &json!({"configured":true,"name":name.trim(),"vaults":safe,"storage":super::setup::storage(),"verified":true}),
            )?;
        }
        Service::Status => {
            let manage_url = "https://start.1password.com/developer-tools/active";
            if super::credential::configured() {
                let token = load()?.ok_or_else(|| {
                    anyhow::anyhow!(
                        "Saved account unavailable; desktop authentication was not attempted"
                    )
                })?;
                let settings = super::credential::settings()?;
                let vaults = super::setup::visible(&token)?;
                super::print(
                    &json!({"configured":true,"name":settings["name"],"vaults":vaults,"tokenRef":settings["tokenRef"],"storage":super::setup::storage(),"verified":true,"manageUrl":manage_url}),
                )?;
            } else {
                super::print(&json!({"configured":false,"manageUrl":manage_url}))?;
            }
        }
        Service::Forget => {
            super::credential::operate("remove", None)?;
            anyhow::ensure!(!super::credential::exists()?, "Local removal is unverified");
            super::credential::remove_settings()?;
            super::print(&json!({"forgotten":true,"remoteRevoked":false}))?;
        }
        Service::Setup(options) => super::setup::run(options)?,
        Service::Recover { name } => {
            let token =
                load()?.ok_or_else(|| anyhow::anyhow!("No saved service account to recover"))?;
            let vaults = super::setup::visible(&token)?;
            super::credential::save_settings(&json!({"name":name,"vaults":vaults}))?;
            super::print(&json!({"configured":true,"name":name,"vaults":vaults,"recovered":true}))?;
        }
    }
    Ok(())
}
