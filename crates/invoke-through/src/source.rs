//! Credential acquisition for invoke-through (ADR 0048 D6/D7).
//!
//! [`TokenSource`] is deliberately **not** `connection_detect::CommandRunner`:
//! the probe runner returns an exit status and a stdout-non-empty bit by
//! contract (C2) and never hands output back, which is exactly right for
//! discovery and exactly wrong for invoke-through, where the token bytes are
//! the point. This trait is the single sanctioned way those bytes enter the
//! broker path, and its contract is the D7 memory-residency rule:
//!
//! - the credential lives in a [`SecretString`], zeroized on drop;
//! - it is never cached, persisted, logged, or transmitted anywhere but the
//!   single upstream Authorization header of the one call it was acquired for;
//! - implementations must keep the bytes out of every error message — the
//!   failure surface is a *class* (timeout, exit status), never tool output.
//!
//! The crate ships the *spec* of which local tool command yields a usable
//! credential (`gh auth token` for github); the daemon supplies the impl that
//! runs it under its scrubbed-env/no-shell/timeout discipline.

use secrecy::SecretString;

use crate::error::InvokeError;

/// The local, networkless command whose stdout is the provider credential.
///
/// These are the same commands the CLI-tool capability probe runs for
/// liveness (ADR 0048 §3d) — chosen to read the tool's own config or the OS
/// keychain and to never contact the provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceToolSpec {
    pub binary: &'static str,
    pub args: &'static [&'static str],
}

/// Which local tool yields an invoke-through credential for a provider, if
/// any. `aws`/`gcp` slot in here with their adapters (sigv4/`gcloud auth
/// print-access-token`) when those providers graduate — v1 is github only.
pub fn source_tool(provider_id: &str) -> Option<SourceToolSpec> {
    match provider_id {
        // `gh auth token` prints the locally stored token (from
        // ~/.config/gh or the OS keychain) and exits 0 without an API call.
        "github" => Some(SourceToolSpec {
            binary: "gh",
            args: &["auth", "token"],
        }),
        _ => None,
    }
}

/// Acquires a fresh credential for one invoke-through call. See the module
/// docs for the memory-residency contract every implementation must honor.
/// Implementations may block (they spawn the source tool); async callers run
/// `acquire` on a blocking thread, *after* egress preflight has passed — a
/// denied call must never touch the credential at all.
pub trait TokenSource: Send + Sync {
    fn acquire(&self) -> Result<SecretString, InvokeError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_acquires_via_gh_auth_token() {
        let spec = source_tool("github").expect("github spec");
        assert_eq!(spec.binary, "gh");
        assert_eq!(spec.args, &["auth", "token"]);
    }

    #[test]
    fn unadopted_providers_have_no_source_tool_in_v1() {
        for provider in ["aws", "gcp", "gitlab", "definitely-not-a-provider"] {
            assert!(source_tool(provider).is_none(), "{provider}");
        }
    }
}
