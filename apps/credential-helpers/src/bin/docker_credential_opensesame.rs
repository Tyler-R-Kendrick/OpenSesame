//! `docker-credential-opensesame` — docker credential helper over the daemon
//! mint path (ADR 0049 §4). Mint mode only.
//!
//! - `get`: reads the server URL on stdin, mints a derived token via the
//!   daemon (`OPENSESAME_DOCKER_CONNECTION_ID`, plus
//!   `OPENSESAME_GITHUB_INSTALLATION_ID` for github App connections), prints
//!   `{"ServerURL","Username","Secret"}`.
//! - `list`: prints `{}` — the helper holds no stored credentials to list.
//! - `store` / `erase`: no-op success.
//!
//! Setup: `"credHelpers": {"ghcr.io": "opensesame"}` in `~/.docker/config.json`.

use opensesame_credential_helpers::{
    docker_protocol, fail, required_env, DaemonClient, HelperError,
};
use std::io::Read;

const DEFAULT_USERNAME: &str = "x-access-token";

const ENV_CONNECTION_ID: &str = "OPENSESAME_DOCKER_CONNECTION_ID";
const ENV_INSTALLATION_ID: &str = "OPENSESAME_GITHUB_INSTALLATION_ID";
const ENV_USERNAME: &str = "OPENSESAME_DOCKER_USERNAME";

fn run() -> Result<(), HelperError> {
    match std::env::args().nth(1).as_deref() {
        Some("get") => get(),
        Some("list") => {
            print!("{}", docker_protocol::render_empty_list());
            Ok(())
        }
        Some("store") | Some("erase") => Ok(()),
        _ => Err(HelperError::Unconfigured(
            "usage: docker-credential-opensesame get|list|store|erase",
        )),
    }
}

fn read_stdin() -> Result<String, HelperError> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| HelperError::Unavailable(error.to_string()))?;
    Ok(input.trim().to_string())
}

fn get() -> Result<(), HelperError> {
    let server_url = read_stdin()?;
    if server_url.is_empty() {
        return Err(HelperError::Unconfigured("a server URL on stdin"));
    }
    let connection_id = required_env(ENV_CONNECTION_ID)?;
    let installation_id = std::env::var(ENV_INSTALLATION_ID)
        .ok()
        .filter(|value| !value.is_empty());
    let minted = DaemonClient::from_env().mint(&connection_id, installation_id.as_deref())?;
    let username = std::env::var(ENV_USERNAME)
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_USERNAME.to_string());
    print!(
        "{}",
        docker_protocol::render_credential(&server_url, &username, &minted.derived_token)
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        fail(error);
    }
}
