//! File encrypt/decrypt via local tooling (`age`, …) — no Host connection crypto.

use std::path::PathBuf;

use clap::Subcommand;
use opensesame_connector_host::providers::{crypto_plan, execute_crypto_plan, CryptoOperation};
use serde_json::json;

#[derive(Subcommand, Debug)]
pub enum CryptoCmd {
    Encrypt {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "age")]
        provider: String,
        #[arg(long)]
        recipient: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        keyring: Option<String>,
        #[arg(long)]
        location: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
    Decrypt {
        #[arg(long)]
        input: PathBuf,
        #[arg(long)]
        output: PathBuf,
        #[arg(long, default_value = "age")]
        provider: String,
        #[arg(long)]
        identity: Option<String>,
        #[arg(long)]
        key: Option<String>,
        #[arg(long)]
        keyring: Option<String>,
        #[arg(long)]
        location: Option<String>,
        #[arg(long)]
        project: Option<String>,
    },
}

pub fn run(cmd: CryptoCmd) -> anyhow::Result<()> {
    let (provider, operation, input, output, public_config) = match cmd {
        CryptoCmd::Encrypt {
            provider,
            input,
            output,
            recipient,
            key,
            keyring,
            location,
            project,
        } => (
            provider,
            CryptoOperation::Encrypt,
            input,
            output,
            config_json(recipient, None, key, keyring, location, project),
        ),
        CryptoCmd::Decrypt {
            provider,
            input,
            output,
            identity,
            key,
            keyring,
            location,
            project,
        } => (
            provider,
            CryptoOperation::Decrypt,
            input,
            output,
            config_json(None, identity, key, keyring, location, project),
        ),
    };
    let plan = crypto_plan(&provider, operation, &input, &output, &public_config)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    execute_crypto_plan(plan).map_err(|error| anyhow::anyhow!("{error}"))?;
    println!("{}", json!({ "written": output, "provider": provider }));
    Ok(())
}

fn config_json(
    recipient: Option<String>,
    identity: Option<String>,
    key: Option<String>,
    keyring: Option<String>,
    location: Option<String>,
    project: Option<String>,
) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    if let Some(value) = recipient {
        map.insert("recipient".into(), value.into());
    }
    if let Some(value) = identity {
        map.insert("identity".into(), value.into());
    }
    if let Some(value) = key {
        map.insert("key".into(), value.into());
    }
    if let Some(value) = keyring {
        map.insert("keyring".into(), value.into());
    }
    if let Some(value) = location {
        map.insert("location".into(), value.into());
    }
    if let Some(value) = project {
        map.insert("project".into(), value.into());
    }
    serde_json::Value::Object(map)
}
