//! Connector discovery for this machine (ADR 0047 offer flow, ADR 0048
//! capability-moded report).
//!
//! Reports which providers *look* configured here and which acquisition modes
//! each supports — import, invoke-through, or mint — so the operator can
//! decide whether to promote any of them into a broker connection. It offers;
//! it never imports.
//!
//! The response is value-blind by contract (C1): provider ids, capabilities,
//! confidence, and the *names* of the variables, files, keychain labels, and
//! MCP env keys that matched. No values, no masked prefixes, and no lengths —
//! a prefix narrows an offline guess, and "it starts with `sk_live_`" is
//! itself a disclosure. Probes hold no network or filesystem handle beyond
//! the injected context, and there is deliberately no "test this credential"
//! action, because a test is an oracle.

use opensesame_connection_detect::{
    build_report, merge_offers, CapabilityProbe, EnvDotfileProbe, McpConfigProbe, OfferItem,
    ProbeContext, ProbeReport,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::{env, fs};

use crate::cli_probe::CliCapabilityProbe;
use crate::keychain::{self, KeychainOfferProbe};
use crate::runner::{self, ScrubbedCommandRunner};

/// Largest credential-adjacent file worth parsing. Matches the broker's bound.
const MAX_CONFIG_BYTES: usize = 8 * 1024;

/// Wording matters: detection is best effort in both directions, and mint or
/// invoke-through promotion is a separate, explicit, per-provider step.
const NOTE: &str =
    "these look configured on this machine; promoting one is a separate, explicit step";

/// The C1 [`ProbeReport`], flattened, plus the ADR 0047 hedge as an additive
/// field. Flattening keeps the frozen report shape exactly as contracted —
/// `schema_version`, `host_label`, `probed_at_unix`, `items` — with `note`
/// alongside rather than wrapped around it.
#[derive(Debug, Serialize)]
pub struct DiscoveryReport {
    #[serde(flatten)]
    pub report: ProbeReport,
    pub note: &'static str,
}

/// Run every probe over `ctx` and return the merged, capability-moded offers.
/// A failing probe degrades to no offers from that probe — a locked keychain
/// or a hung CLI must not take down the rest of the walk.
pub fn offers(ctx: &ProbeContext) -> Vec<OfferItem> {
    let probes: [&dyn CapabilityProbe; 4] = [
        &EnvDotfileProbe,
        &McpConfigProbe,
        &KeychainOfferProbe,
        &CliCapabilityProbe,
    ];
    let mut items = Vec::new();
    for probe in probes {
        match probe.probe(ctx) {
            Ok(mut found) => items.append(&mut found),
            Err(error) => {
                tracing::warn!(probe = probe.id(), %error, "discovery probe failed; continuing");
            }
        }
    }
    merge_offers(items)
}

/// Scan this host with an injected probe context.
pub fn report_with(
    ctx: &ProbeContext,
    host_label: impl Into<String>,
    probed_at_unix: u64,
) -> DiscoveryReport {
    DiscoveryReport {
        report: build_report(host_label.into(), probed_at_unix, offers(ctx)),
        note: NOTE,
    }
}

/// A display label for this host. The hostname only — never a machine-id,
/// which is a stable cross-context identifier and stays out of reports.
fn host_label() -> String {
    env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| {
            fs::read_to_string("/etc/hostname")
                .ok()
                .map(|h| h.trim().to_string())
                .filter(|h| !h.is_empty())
        })
        .unwrap_or_else(|| "localhost".to_string())
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Build the probe context for this daemon process — and nowhere else: a
/// snapshot of the process environment (probes never read it directly), the
/// platform keychain backend, and a scrubbed command runner that sees only a
/// whitelist of that snapshot — the daemon's own `OPENSESAME_*` secrets never
/// reach a child.
pub fn probe_context() -> ProbeContext {
    let env: BTreeMap<String, String> = env::vars().collect();
    let home_dir = env
        .get("HOME")
        .filter(|h| !h.is_empty())
        .map_or_else(|| PathBuf::from("/"), PathBuf::from);
    ProbeContext {
        home_dir,
        keychain: keychain::platform_backend(),
        commands: Arc::new(ScrubbedCommandRunner::new(runner::minimal_child_env(&env))),
        env,
        max_read_bytes: MAX_CONFIG_BYTES,
    }
}

/// Scan the daemon's real environment, home directory, platform keychain, and
/// PATH against a freshly built [`probe_context`].
pub fn report() -> DiscoveryReport {
    report_with(&probe_context(), host_label(), now_unix())
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_detect::{
        CapabilityClass, CommandStatus, Confidence, KeychainStore, MockCommandRunner, MockKeychain,
        ProbeSource,
    };
    use std::fs;

    /// A hermetic probe context: env vars from `vars`, files written under a
    /// fresh tempdir as the home directory, a mock keychain, a scripted
    /// runner. Nothing here touches the host's real environment or files.
    struct Fixture {
        home: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                home: tempfile::tempdir().expect("tempdir"),
            }
        }

        fn write_home_file(&self, relative: &str, contents: &str) {
            let path = self.home.path().join(relative);
            fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
            fs::write(path, contents).expect("write fixture");
        }

        fn ctx(
            &self,
            vars: &[(&str, &str)],
            keychain: MockKeychain,
            commands: MockCommandRunner,
        ) -> ProbeContext {
            let mut env: BTreeMap<String, String> = vars
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
                .collect();
            env.insert(
                "HOME".to_string(),
                self.home.path().to_string_lossy().into_owned(),
            );
            ProbeContext {
                home_dir: self.home.path().to_path_buf(),
                env,
                keychain: Arc::new(keychain),
                commands: Arc::new(commands),
                max_read_bytes: MAX_CONFIG_BYTES,
            }
        }
    }

    const LIVE: CommandStatus = CommandStatus {
        success: true,
        stdout_non_empty: true,
    };

    #[test]
    fn adversarial_report_never_carries_a_planted_secret() {
        let stripe = "PLANTED-STRIPE-VALUE-MUST-NOT-ESCAPE";
        let github = "PLANTED-GITHUB-VALUE-MUST-NOT-ESCAPE";
        let mcp_token = "PLANTED-MCP-ENV-VALUE-MUST-NOT-ESCAPE";
        let fixture = Fixture::new();
        fixture.write_home_file(
            ".mcp.json",
            &format!(
                r#"{{"mcpServers": {{"github": {{"command": "npx", "env": {{"GITHUB_TOKEN": "{mcp_token}"}}}}}}}}"#
            ),
        );
        // A keychain label is a display name; the value behind it lives in the
        // mock's "store" and has no path into the report.
        let keychain =
            MockKeychain::new().with_label(KeychainStore::SecretService, "gh:github.com");
        let commands = MockCommandRunner::new().with_status(&["gh", "auth", "token"], LIVE);
        let ctx = fixture.ctx(
            &[("STRIPE_SECRET_KEY", stripe), ("GITHUB_TOKEN", github)],
            keychain,
            commands,
        );

        let report = report_with(&ctx, "test-host", 1_700_000_000);
        let rendered = serde_json::to_string(&report).expect("serializable");

        assert!(rendered.contains("stripe"), "{rendered}");
        assert!(rendered.contains("STRIPE_SECRET_KEY"));
        assert!(rendered.contains("gh:github.com"));
        // The contract this route lives or dies by.
        assert!(!rendered.contains(stripe));
        assert!(!rendered.contains(github));
        assert!(!rendered.contains(mcp_token));
    }

    #[test]
    fn contract_a_clean_machine_reports_nothing() {
        let fixture = Fixture::new();
        let ctx = fixture.ctx(&[], MockKeychain::new(), MockCommandRunner::new());
        let report = report_with(&ctx, "test-host", 1_700_000_000);
        assert!(report.report.items.is_empty());
        assert_eq!(report.report.schema_version, 1);
        assert_eq!(report.report.host_label, "test-host");
    }

    #[test]
    fn property_offers_merge_per_provider_source_with_best_confidence() {
        let fixture = Fixture::new();
        fixture.write_home_file(
            ".mcp.json",
            r#"{"mcpServers": {"github": {"command": "npx"}}}"#,
        );
        let keychain =
            MockKeychain::new().with_label(KeychainStore::SecretService, "gh:github.com");
        let commands = MockCommandRunner::new().with_status(&["gh", "auth", "token"], LIVE);
        // A fake gh on PATH so the CLI probe fires.
        fixture.write_home_file("bin/gh", "#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                fixture.home.path().join("bin/gh"),
                fs::Permissions::from_mode(0o755),
            )
            .expect("chmod");
        }
        let path = fixture
            .home
            .path()
            .join("bin")
            .to_string_lossy()
            .into_owned();
        let ctx = fixture.ctx(
            &[("GITHUB_TOKEN", "ghp_x"), ("PATH", &path)],
            keychain,
            commands,
        );

        let report = report_with(&ctx, "test-host", 1_700_000_000);
        let github: Vec<_> = report
            .report
            .items
            .iter()
            .filter(|item| item.provider_id == "github")
            .collect();
        // One item per source identity: env var, MCP stanza, keychain label,
        // CLI binary.
        assert_eq!(github.len(), 4, "{github:?}");
        let cli = github
            .iter()
            .find(|item| matches!(item.source, ProbeSource::CliTool { .. }))
            .expect("cli offer");
        assert_eq!(cli.confidence, Confidence::High);
        assert_eq!(
            cli.capabilities,
            vec![CapabilityClass::InvokeThrough, CapabilityClass::Mintable]
        );
        let keychain_offer = github
            .iter()
            .find(|item| matches!(item.source, ProbeSource::Keychain { .. }))
            .expect("keychain offer");
        assert_eq!(keychain_offer.confidence, Confidence::High);
        assert_eq!(
            keychain_offer.capabilities,
            vec![CapabilityClass::Importable]
        );
    }

    #[test]
    fn a_failing_probe_degrades_instead_of_failing_the_report() {
        struct BrokenKeychain;
        impl opensesame_connection_detect::KeychainBackend for BrokenKeychain {
            fn enumerate_labels(
                &self,
            ) -> Result<Vec<(KeychainStore, String)>, opensesame_connection_detect::ProbeError>
            {
                Err(opensesame_connection_detect::ProbeError::Keychain(
                    "locked behind a prompt we will not trigger".to_string(),
                ))
            }
        }
        let fixture = Fixture::new();
        let mut ctx = fixture.ctx(
            &[("STRIPE_SECRET_KEY", "sk_live_x")],
            MockKeychain::new(),
            MockCommandRunner::new(),
        );
        ctx.keychain = Arc::new(BrokenKeychain);
        let report = report_with(&ctx, "test-host", 1_700_000_000);
        assert!(report
            .report
            .items
            .iter()
            .any(|item| item.provider_id == "stripe"));
    }

    #[cfg(test)]
    mod characterization {
        use super::*;

        /// Snapshot of the wire shape of a discovery report.
        ///
        /// This does not assert the shape is *right* — the tests above do that.
        /// It pins what the route actually serializes, so a new field has to be
        /// looked at and accepted rather than shipped unnoticed. On this route
        /// that matters more than most: the whole contract is that a provider
        /// is named and its credential never is, and the cheapest way to break
        /// it is to add a helpful-looking field.
        ///
        /// If this fails, read the diff. A new key here is a disclosure
        /// decision. The accepted shape was reviewed to contain only provider
        /// ids, source *names* (variables, paths, labels, MCP env key names),
        /// capability classes, and confidence — no values, prefixes, lengths,
        /// or host identifiers beyond the caller-supplied label.
        #[test]
        fn contract_report_wire_shape_is_pinned() {
            let fixture = Fixture::new();
            fixture.write_home_file(
                ".mcp.json",
                r#"{"mcpServers": {"github": {"command": "npx", "env": {"GITHUB_TOKEN": "PLANTED-MCP-VALUE-MUST-NOT-ESCAPE"}}}}"#,
            );
            let keychain =
                MockKeychain::new().with_label(KeychainStore::SecretService, "gh:github.com");
            let ctx = fixture.ctx(
                &[
                    ("STRIPE_SECRET_KEY", "PLANTED-VALUE-MUST-NOT-ESCAPE"),
                    ("VAULT_TOKEN", "PLANTED-VALUE-MUST-NOT-ESCAPE"),
                ],
                keychain,
                MockCommandRunner::new(),
            );

            let report = report_with(&ctx, "test-host", 1_700_000_000);
            // Source paths embed the fixture tempdir; redact them so the pin
            // is about the *shape*, and eyeball the rest in review.
            insta::assert_json_snapshot!(report, {
                ".items[].source.path" => "[path]",
            });
        }
    }
}
