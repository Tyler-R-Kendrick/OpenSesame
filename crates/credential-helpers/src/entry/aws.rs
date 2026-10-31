//! `opensesame-credential-process` — AWS `credential_process` over the daemon
//! mint path (ADR 0049 §4). Mint mode only.
//!
//! The Host assumes the role bound to the connection with STS (ADR 0217) and
//! the daemon passes STS's temporary credential back; this prints it in the
//! `credential_process` JSON shape. A connection with no STS binding is
//! `422 unmintable` and the binary exits non-zero, printing nothing.
//!
//! Setup: `credential_process = opensesame-credential-process` in a
//! `~/.aws/config` profile, with `OPENSESAME_AWS_CONNECTION_ID` set and,
//! optionally, `OPENSESAME_AWS_DURATION_SECONDS` (900 up to the binding's cap).

use crate::{aws_protocol, required_env, DaemonClient, HelperError};
use serde_json::Value;

const ENV_CONNECTION_ID: &str = "OPENSESAME_AWS_CONNECTION_ID";
const ENV_DURATION: &str = "OPENSESAME_AWS_DURATION_SECONDS";

/// The lifetime to ask for, when one is configured. A value that is not a
/// whole number of seconds is a configuration error, not a default.
fn duration() -> Result<Option<u32>, HelperError> {
    match std::env::var(ENV_DURATION)
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        None => Ok(None),
        Some(value) => value
            .trim()
            .parse::<u32>()
            .map(Some)
            .map_err(|_| HelperError::Unconfigured(ENV_DURATION)),
    }
}

fn run() -> Result<(), HelperError> {
    let connection_id = required_env(ENV_CONNECTION_ID)?;
    let minted = DaemonClient::from_env().mint_for(&connection_id, None, duration()?)?;
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
        // An answer without the STS shape is refused: never print a partial
        // credential.
        _ => Err(HelperError::Malformed),
    }
}

/// Answer one helper invocation.
pub fn main() {
    if let Err(error) = run() {
        match &error {
            HelperError::Denied(422, _) => eprintln!(
                "opensesame: unmintable: this aws connection has no STS binding to mint for \
                 (ADR 0217: PUT /api/v1/connections/{{id}}/aws-sts-binding)"
            ),
            _ => eprintln!("opensesame: {error}"),
        }
        std::process::exit(1);
    }
}
