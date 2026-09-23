//! `git-credential-opensesame` — git credential helper over the daemon mint
//! path (ADR 0049 §4). Mint mode only: the connection must be opted into
//! `materialization = derived_short_lived`.
//!
//! - `get`: reads the git credential protocol on stdin and, only when git is
//!   asking for `protocol=https` on a host in the allowlist
//!   (`OPENSESAME_GIT_HOSTS`, comma-separated, default `github.com`), mints a
//!   derived token via the daemon (`OPENSESAME_GIT_CONNECTION_ID`, plus
//!   `OPENSESAME_GITHUB_INSTALLATION_ID` for github App connections) and
//!   prints `username`/`password`. Any other request gets no answer, so git
//!   falls through to its next helper — a token minted for GitHub never goes
//!   to another host, and never over plain `http`.
//! - `store` / `erase`: no-op success — nothing is ever persisted here.
//!
//! Setup: `git config --global credential.helper opensesame`.

use opensesame_credential_helpers::{fail, git_protocol, required_env, DaemonClient, HelperError};
use std::collections::BTreeMap;
use std::io::Read;

/// The git credential helper convention for token auth over HTTPS.
const DEFAULT_USERNAME: &str = "x-access-token";

const ENV_CONNECTION_ID: &str = "OPENSESAME_GIT_CONNECTION_ID";
const ENV_INSTALLATION_ID: &str = "OPENSESAME_GITHUB_INSTALLATION_ID";
const ENV_USERNAME: &str = "OPENSESAME_GIT_USERNAME";
const ENV_HOSTS: &str = "OPENSESAME_GIT_HOSTS";

/// Hosts the configured connection's token is for when `OPENSESAME_GIT_HOSTS`
/// is unset: the connection is a GitHub one.
const DEFAULT_HOSTS: &str = "github.com";

/// Should this `get` be answered at all? Only for `protocol=https` and a
/// `host=` (with any `:port`) that exactly matches an allowlisted entry — no
/// suffix or subdomain matching, so `github.com.evil.example` and
/// `evil.github.com` both fall through.
fn request_allowed(fields: &BTreeMap<String, String>, allowed_hosts: &str) -> bool {
    if fields.get("protocol").map(String::as_str) != Some("https") {
        return false;
    }
    let Some(host) = fields.get("host").map(|h| h.trim().to_ascii_lowercase()) else {
        return false;
    };
    !host.is_empty()
        && allowed_hosts
            .split(',')
            .map(|entry| entry.trim().to_ascii_lowercase())
            .any(|entry| entry == host)
}

fn run() -> Result<(), HelperError> {
    match std::env::args().nth(1).as_deref() {
        Some("get") => get(),
        // A helper that never stores is a correct store/erase: git treats a
        // clean exit as handled.
        Some("store" | "erase") => Ok(()),
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
    // The mint always targets the configured connection id — a crafted
    // host= line cannot redirect it — but the *answer* goes to whatever host
    // git is talking to, so only an allowlisted https host gets one.
    let fields = git_protocol::parse_input(&input);
    let allowed_hosts = std::env::var(ENV_HOSTS)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_HOSTS.to_string());
    if !request_allowed(&fields, &allowed_hosts) {
        return Ok(());
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
        git_protocol::render_credential(&username, &minted.derived_token)
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        fail(error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(input: &str, hosts: &str) -> bool {
        request_allowed(&git_protocol::parse_input(input), hosts)
    }

    #[test]
    fn only_https_to_an_allowlisted_host_is_answered() {
        assert!(allowed(
            "protocol=https\nhost=github.com\n\n",
            DEFAULT_HOSTS
        ));
        assert!(allowed(
            "protocol=https\nhost=GitHub.com\npath=o/r.git\n",
            DEFAULT_HOSTS
        ));
        let enterprise = "github.com, ghe.example.com:8443";
        assert!(allowed(
            "protocol=https\nhost=ghe.example.com:8443\n",
            enterprise
        ));
        assert!(!allowed(
            "protocol=https\nhost=ghe.example.com\n",
            enterprise
        ));
    }

    #[test]
    fn any_other_host_or_scheme_falls_through() {
        for input in [
            "protocol=http\nhost=github.com\n",
            "protocol=HTTPS\nhost=github.com\n",
            "protocol=https\nhost=gitlab.com\n",
            "protocol=https\nhost=github.com.evil.example\n",
            "protocol=https\nhost=evil.github.com\n",
            "protocol=https\nhost=attacker.github.io\n",
            "protocol=https\nhost=github.com:444\n",
            "protocol=https\nhost=\n",
            "protocol=https\n",
            "host=github.com\n",
            "protocol=ssh\nhost=github.com\n",
            "",
        ] {
            assert!(!allowed(input, DEFAULT_HOSTS), "{input:?}");
        }
        // An empty allowlist entry never matches an empty or missing host.
        assert!(!allowed("protocol=https\nhost=\n", ",github.com"));
    }

    #[test]
    fn lines_after_the_blank_terminator_are_not_read() {
        let input = "protocol=https\nhost=evil.example\n\nhost=github.com\n";
        assert!(!allowed(input, DEFAULT_HOSTS));
    }
}
