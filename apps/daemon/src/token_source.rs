//! `TokenSource` over the scrubbed runner (ADR 0048 D6/D7).
//!
//! This is where the daemon turns "a provider CLI holds a credential on this
//! machine" into one fresh [`SecretString`] for one invoke-through call. The
//! acquisition inherits every runner discipline — scrubbed environment, no
//! shell, strict timeout, capped capture — and adds nothing: the token exists
//! only as the returned `SecretString`, zeroized on drop, never cached here.
//!
//! v1 is github only (`gh auth token`); aws/gcp adapters slot into
//! [`CliTokenSource::for_provider`] through `source_tool` as they land.

use opensesame_invoke_through::{source_tool, InvokeError, SourceToolSpec, TokenSource};
use secrecy::SecretString;
use std::collections::BTreeMap;

use crate::runner::{minimal_child_env, ScrubbedCommandRunner};

/// Same budget as CLI liveness probes: long enough for a cold CLI start,
/// short enough that a keychain ACL prompt the OS is waiting on cannot wedge
/// an invoke-through request.
const ACQUIRE_TIMEOUT_MS: u64 = 5_000;

/// A [`TokenSource`] that runs the provider's local credential command under
/// the scrubbed runner.
pub struct CliTokenSource {
    runner: ScrubbedCommandRunner,
    spec: SourceToolSpec,
}

impl CliTokenSource {
    /// The source for a provider, or `None` when no adapter exists (the
    /// caller maps that to 422 — the route never invents one).
    pub fn for_provider(provider_id: &str, env: &BTreeMap<String, String>) -> Option<Self> {
        let spec = source_tool(provider_id)?;
        Some(Self {
            runner: ScrubbedCommandRunner::new(minimal_child_env(env)),
            spec,
        })
    }
}

impl TokenSource for CliTokenSource {
    fn acquire(&self) -> Result<SecretString, InvokeError> {
        let argv: Vec<&str> = std::iter::once(self.spec.binary)
            .chain(self.spec.args.iter().copied())
            .collect();
        // ProbeError messages from the runner are failure classes by
        // construction (spawn/timeout/exit-status/overflow) — never output.
        self.runner
            .run_capture(&argv, ACQUIRE_TIMEOUT_MS)
            .map_err(|error| InvokeError::TokenUnavailable(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use secrecy::ExposeSecret;

    /// Test-only construction with a scripted spec, so acquisition can be
    /// exercised without a real `gh` on PATH.
    impl CliTokenSource {
        pub(crate) fn with_spec(spec: SourceToolSpec, env: &BTreeMap<String, String>) -> Self {
            Self {
                runner: ScrubbedCommandRunner::new(minimal_child_env(env)),
                spec,
            }
        }
    }

    fn env() -> BTreeMap<String, String> {
        BTreeMap::from([("PATH".to_string(), "/usr/bin:/bin".to_string())])
    }

    #[test]
    fn github_acquires_via_gh_auth_token() {
        let source = CliTokenSource::for_provider("github", &env()).expect("github adapter");
        assert_eq!(source.spec.binary, "gh");
        assert_eq!(source.spec.args, &["auth", "token"]);
    }

    #[test]
    fn unadopted_providers_have_no_adapter() {
        for provider in ["aws", "gcp", "gitlab"] {
            assert!(CliTokenSource::for_provider(provider, &env()).is_none());
        }
    }

    #[test]
    fn acquisition_returns_the_printed_credential() {
        let source = CliTokenSource::with_spec(
            SourceToolSpec {
                binary: "sh",
                args: &["-c", "printf 'gho_test-token\\n'"],
            },
            &env(),
        );
        let token = source.acquire().expect("acquired");
        assert_eq!(token.expose_secret(), "gho_test-token");
    }

    #[test]
    fn acquisition_failure_is_a_class_not_the_output() {
        let source = CliTokenSource::with_spec(
            SourceToolSpec {
                binary: "sh",
                args: &["-c", "echo PLANTED-SECRET-OUTPUT; exit 1"],
            },
            &env(),
        );
        let error = source.acquire().expect_err("failing tool");
        let rendered = format!("{error} / {error:?}");
        assert!(matches!(error, InvokeError::TokenUnavailable(_)));
        assert!(!rendered.contains("PLANTED-SECRET-OUTPUT"), "{rendered}");
    }
}
