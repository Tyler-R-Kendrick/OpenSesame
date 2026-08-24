//! `opensesame-credential-process` — AWS `credential_process` over the daemon
//! mint path (ADR 0049 §4). Mint mode only.
//!
//! v1 fails closed: the gateway's AWS mint arm is a `422 unmintable`
//! follow-up (ADR 0049 §3), so this binary exits non-zero with a clear
//! message until STS minting lands. The success path is already wired: when
//! the daemon returns `access_key_id` / `secret_access_key` / `session_token`
//! fields, they are printed in the `credential_process` JSON shape.
//!
//! Setup: `credential_process = opensesame-credential-process` in a
//! `~/.aws/config` profile, with `OPENSESAME_AWS_CONNECTION_ID` set.

use opensesame_credential_helpers::{aws_protocol, required_env, DaemonClient, HelperError};
use serde_json::Value;

const ENV_CONNECTION_ID: &str = "OPENSESAME_AWS_CONNECTION_ID";

fn run() -> Result<(), HelperError> {
    let connection_id = required_env(ENV_CONNECTION_ID)?;
    let minted = DaemonClient::from_env().mint(&connection_id, None)?;
    // The AWS mint response carries STS session fields rather than a single
    // bearer token; require all three — a partial credential is no credential.
    let field = |name: &str| {
        minted
            .raw
            .get(name)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    match (
        field("access_key_id"),
        field("secret_access_key"),
        field("session_token"),
    ) {
        (Some(access_key_id), Some(secret_access_key), Some(session_token)) => {
            print!(
                "{}",
                aws_protocol::render_credentials(
                    &access_key_id,
                    &secret_access_key,
                    &session_token,
                    minted.expires_at.as_deref(),
                )
            );
            Ok(())
        }
        // Reached only if an AWS mint lands without the STS shape; failing
        // closed here is deliberate — never print a partial credential.
        _ => Err(HelperError::Malformed),
    }
}

fn main() {
    if let Err(error) = run() {
        match &error {
            HelperError::Denied(422, _) => eprintln!(
                "opensesame: aws connections are unmintable in v1 (ADR 0049) — \
                 credential_process lights up when the STS mint arm lands"
            ),
            _ => eprintln!("opensesame: {error}"),
        }
        std::process::exit(1);
    }
}
