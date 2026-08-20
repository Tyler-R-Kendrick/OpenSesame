//! `opensesame-kube-exec` — kubectl client-go exec plugin over the daemon
//! mint path (ADR 0049 §4). Mint mode only.
//!
//! v1 fails closed: no provider with a kubernetes-mintable connection exists
//! yet, so the daemon answers `422 unmintable` (or the connection id is
//! unconfigured) and this binary exits non-zero with a clear message. The
//! success path is wired: a minted `derived_token` is printed as an
//! ExecCredential.
//!
//! Setup: an `exec` stanza in the kubeconfig with
//! `command: opensesame-kube-exec`, `apiVersion: client.authentication.k8s.io/v1`,
//! and `OPENSESAME_KUBE_CONNECTION_ID` set.

use opensesame_credential_helpers::{kube_protocol, required_env, DaemonClient, HelperError};

const ENV_CONNECTION_ID: &str = "OPENSESAME_KUBE_CONNECTION_ID";
/// Optional installation id for github-backed clusters.
const ENV_INSTALLATION_ID: &str = "OPENSESAME_GITHUB_INSTALLATION_ID";

fn run() -> Result<(), HelperError> {
    let connection_id = required_env(ENV_CONNECTION_ID)?;
    let installation_id = std::env::var(ENV_INSTALLATION_ID)
        .ok()
        .filter(|value| !value.is_empty());
    let minted = DaemonClient::from_env().mint(&connection_id, installation_id.as_deref())?;
    print!(
        "{}",
        kube_protocol::render_exec_credential(&minted.derived_token, minted.expires_at.as_deref())
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        match &error {
            HelperError::Denied(422, _) => eprintln!(
                "opensesame: this connection has no mint path in v1 (ADR 0049) — \
                 the exec plugin lights up when a mintable provider backs it"
            ),
            _ => eprintln!("opensesame: {error}"),
        }
        std::process::exit(1);
    }
}
