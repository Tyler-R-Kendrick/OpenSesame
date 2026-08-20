//! `git-credential-opensesame` — git credential helper over the daemon mint
//! path (ADR 0049 §4). Mint mode only: the connection must be opted into
//! `materialization = derived_short_lived`.
//!
//! - `get`: reads the git credential protocol on stdin, mints a derived token
//!   via the daemon (`OPENSESAME_GIT_CONNECTION_ID`, plus
//!   `OPENSESAME_GITHUB_INSTALLATION_ID` for github App connections), prints
//!   `username`/`password`.
//! - `store` / `erase`: no-op success — nothing is ever persisted here.
//!
//! Setup: `git config --global credential.helper opensesame`.

use opensesame_credential_helpers::{fail, git_protocol, required_env, DaemonClient, HelperError};
use std::io::Read;

/// The git credential helper convention for token auth over HTTPS.
const DEFAULT_USERNAME: &str = "x-access-token";

const ENV_CONNECTION_ID: &str = "OPENSESAME_GIT_CONNECTION_ID";
const ENV_INSTALLATION_ID: &str = "OPENSESAME_GITHUB_INSTALLATION_ID";
const ENV_USERNAME: &str = "OPENSESAME_GIT_USERNAME";

fn run() -> Result<(), HelperError> {
    match std::env::args().nth(1).as_deref() {
        Some("get") => get(),
        // A helper that never stores is a correct store/erase: git treats a
        // clean exit as handled.
        Some("store") | Some("erase") => Ok(()),
        _ => Err(HelperError::Unconfigured(
            "usage: git-credential-opensesame get|store|erase",
        )),
    }
}

fn get() -> Result<(), HelperError> {
    let mut input = String::new();
    std::io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| HelperError::Unavailable(error.to_string()))?;
    // The protocol fields (host, path) describe the repo, not the connection:
    // v1 mints against the configured connection id regardless of host, so a
    // crafted host= line cannot redirect the mint elsewhere.
    let _ = git_protocol::parse_input(&input);
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
        git_protocol::render_credential(&username, &minted.derived_token)
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        fail(error);
    }
}
