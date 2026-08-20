//! CLI-tool capability probe (ADR 0048 §3d).
//!
//! A live provider CLI on `PATH` is an invoke-through offer: OpenSesame can
//! broker calls through a credential that stays where the CLI keeps it. The
//! probe does two things, both networkless by construction:
//!
//! 1. **Binary presence** — a which-style walk of the injected `PATH`
//!    snapshot. No shell, no filesystem handle beyond existence checks.
//! 2. **Liveness** — one carefully chosen subcommand per tool that answers
//!    "is a credential stored locally" from the tool's own config or the OS
//!    keychain, via the injected [`CommandRunner`] (scrubbed env, exit status
//!    and a stdout-non-empty bit only — never output bytes).
//!
//! The liveness commands below are chosen to never reach the provider. The
//! canonical refusal is `aws sts get-caller-identity`: a network call dressed
//! up as a check. Where a tool has no reliable networkless check (`az`,
//! `infisical`, `docker`, `vault`, `bao`), binary presence alone is reported
//! at [`Confidence::Low`].
//!
//! Caveat: the subcommands are networkless *by design of the tool*, not by
//! enforcement — a CLI could still e.g. phone home for an update check. The
//! scrubbed environment and the strict timeout bound what that can observe
//! and how long it can take.

use opensesame_connection_detect::{
    mint_capable, CapabilityClass, CapabilityProbe, Confidence, OfferItem, ProbeContext,
    ProbeError, ProbeSource,
};
use std::path::Path;

/// Long enough for Python CLIs (`aws`, `gcloud`) to cold-start; short enough
/// that a hung child — killed by the runner — cannot stall discovery.
const LIVENESS_TIMEOUT_MS: u64 = 5_000;

/// A networkless liveness check: argv after the binary, and whether stdout
/// must be non-empty for the check to count (for subcommands that print the
/// stored credential — the bytes are discarded by the runner; only the fact
/// that something was printed is signal).
struct LivenessCheck {
    args: &'static [&'static str],
    require_stdout: bool,
}

struct CliToolSpec {
    binary: &'static str,
    provider_ids: &'static [&'static str],
    liveness: Option<LivenessCheck>,
}

const CLI_TOOLS: &[CliToolSpec] = &[
    CliToolSpec {
        binary: "gh",
        provider_ids: &["github"],
        // `gh auth token` prints the locally stored token (config file or OS
        // keychain) and exits 0; it makes no API call.
        liveness: Some(LivenessCheck {
            args: &["auth", "token"],
            require_stdout: true,
        }),
    },
    CliToolSpec {
        binary: "glab",
        provider_ids: &["gitlab"],
        // `glab auth token` prints the stored token from config/keyring
        // (glab ≥ 1.36). Older glabs lack the subcommand and exit non-zero,
        // which correctly degrades to presence-only. `glab auth status`
        // contacts the instance and is deliberately not used.
        liveness: Some(LivenessCheck {
            args: &["auth", "token"],
            require_stdout: true,
        }),
    },
    CliToolSpec {
        binary: "aws",
        provider_ids: &["aws"],
        // `aws configure list` renders the local credential/config table from
        // files and the process environment. `aws sts get-caller-identity` —
        // the tempting "real" check — reaches AWS and is refused by design.
        liveness: Some(LivenessCheck {
            args: &["configure", "list"],
            require_stdout: true,
        }),
    },
    CliToolSpec {
        binary: "gcloud",
        provider_ids: &["gcp"],
        // `gcloud config get-value account` reads the local gcloud config;
        // exit non-zero / empty stdout when no account is active. No auth
        // flow is contacted.
        liveness: Some(LivenessCheck {
            args: &["config", "get-value", "account"],
            require_stdout: true,
        }),
    },
    CliToolSpec {
        binary: "az",
        provider_ids: &["azure-sm"],
        // Every plausible account query (`az account list`, `az account
        // show`) may attempt a token refresh against Entra ID. No reliable
        // networkless check exists, so presence only.
        liveness: None,
    },
    CliToolSpec {
        binary: "op",
        provider_ids: &["1password"],
        // `op account list` reads the local CLI config; it does not sign in
        // or contact 1password.com.
        liveness: Some(LivenessCheck {
            args: &["account", "list"],
            require_stdout: false,
        }),
    },
    CliToolSpec {
        binary: "doppler",
        provider_ids: &["doppler"],
        // `doppler configure get token` prints the token from the local
        // config file (discarded by the runner); no API call.
        liveness: Some(LivenessCheck {
            args: &["configure", "get", "token"],
            require_stdout: true,
        }),
    },
    CliToolSpec {
        binary: "infisical",
        provider_ids: &["infisical"],
        // `infisical whoami` contacts the API; there is no documented
        // offline check. Presence only.
        liveness: None,
    },
    CliToolSpec {
        binary: "kubectl",
        provider_ids: &["kubernetes"],
        // `kubectl config current-context` reads the kubeconfig file only;
        // exit non-zero when no context is set. It never dials a cluster.
        liveness: Some(LivenessCheck {
            args: &["config", "current-context"],
            require_stdout: false,
        }),
    },
    CliToolSpec {
        binary: "docker",
        provider_ids: &["docker"],
        // Every install has a default context, so `docker context show`
        // discriminates nothing, and `docker info` measures the daemon, not
        // a credential. The credential side of docker is found via
        // `docker-credential-*` keychain labels. Presence only.
        liveness: None,
    },
    CliToolSpec {
        binary: "vault",
        provider_ids: &["vault"],
        // `vault status` / `vault token lookup` both contact the server.
        // The `~/.vault-token` dotfile probe covers the common local case.
        // Presence only.
        liveness: None,
    },
    CliToolSpec {
        binary: "bao",
        provider_ids: &["openbao"],
        // Same shape as vault: all liveness checks reach the server, and
        // `~/.bao-token` is covered by the dotfile probe. Presence only.
        liveness: None,
    },
];

/// Whether `binary` resolves on the injected `PATH` snapshot — a which-style
/// walk with no shell.
fn binary_on_path(ctx: &ProbeContext, binary: &str) -> bool {
    let Some(path) = ctx.env.get("PATH") else {
        return false;
    };
    std::env::split_paths(path).any(|dir| {
        is_executable(&dir.join(binary)) || is_executable(&dir.join(format!("{binary}.exe")))
    })
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// Emits one offer per (tool, provider) for every tool found on `PATH`:
/// `[InvokeThrough]` plus `[Mintable]` for providers with a native mint path,
/// high confidence when the networkless liveness check passed, low when the
/// binary is merely present.
pub struct CliCapabilityProbe;

impl CliCapabilityProbe {
    fn is_live(ctx: &ProbeContext, tool: &CliToolSpec) -> bool {
        let Some(check) = &tool.liveness else {
            return false;
        };
        let mut argv = vec![tool.binary];
        argv.extend_from_slice(check.args);
        match ctx.commands.run_status(&argv, LIVENESS_TIMEOUT_MS) {
            Ok(status) => status.success && (!check.require_stdout || status.stdout_non_empty),
            // Spawn failure, timeout, an unresponsive keychain — all just
            // "not proven live", never a probe failure.
            Err(_) => false,
        }
    }
}

impl CapabilityProbe for CliCapabilityProbe {
    fn id(&self) -> &'static str {
        "cli-tool"
    }

    fn probe(&self, ctx: &ProbeContext) -> Result<Vec<OfferItem>, ProbeError> {
        let mut items = Vec::new();
        for tool in CLI_TOOLS {
            if !binary_on_path(ctx, tool.binary) {
                continue;
            }
            let confidence = if Self::is_live(ctx, tool) {
                Confidence::High
            } else {
                Confidence::Low
            };
            for provider_id in tool.provider_ids {
                let mut capabilities = vec![CapabilityClass::InvokeThrough];
                if mint_capable(provider_id) {
                    capabilities.push(CapabilityClass::Mintable);
                }
                items.push(OfferItem {
                    provider_id: (*provider_id).to_string(),
                    source: ProbeSource::CliTool {
                        binary: tool.binary.to_string(),
                        version: None,
                    },
                    capabilities,
                    confidence,
                    registry_hint: None,
                });
            }
        }
        Ok(items)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opensesame_connection_detect::{CommandStatus, MockCommandRunner, MockKeychain};
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Arc;

    /// A fake `bin/` directory holding empty executable files, so presence
    /// checks resolve without touching the host's real PATH.
    struct FakeBin {
        dir: tempfile::TempDir,
    }

    impl FakeBin {
        fn with(binaries: &[&str]) -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            for binary in binaries {
                let path = dir.path().join(binary);
                fs::write(&path, b"#!/bin/sh\n").expect("write fake binary");
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("chmod");
                }
            }
            Self { dir }
        }

        fn path(&self) -> String {
            self.dir.path().to_string_lossy().into_owned()
        }
    }

    fn ctx_with(bin: &FakeBin, commands: MockCommandRunner) -> ProbeContext {
        let mut env = BTreeMap::new();
        env.insert("PATH".to_string(), bin.path());
        ProbeContext {
            home_dir: PathBuf::from("/nonexistent"),
            env,
            keychain: Arc::new(MockKeychain::new()),
            commands: Arc::new(commands),
            max_read_bytes: 8 * 1024,
        }
    }

    fn live(args: &[&str]) -> MockCommandRunner {
        MockCommandRunner::new().with_status(
            args,
            CommandStatus {
                success: true,
                stdout_non_empty: true,
            },
        )
    }

    fn offer_for<'a>(items: &'a [OfferItem], provider: &str) -> &'a OfferItem {
        items
            .iter()
            .find(|item| item.provider_id == provider)
            .unwrap_or_else(|| panic!("no offer for {provider}: {items:?}"))
    }

    #[test]
    fn a_live_cli_is_a_high_confidence_invoke_through_offer() {
        let bin = FakeBin::with(&["gh"]);
        let ctx = ctx_with(&bin, live(&["gh", "auth", "token"]));
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        let github = offer_for(&items, "github");
        assert_eq!(github.confidence, Confidence::High);
        assert_eq!(
            github.capabilities,
            // github is mint-capable (App installation tokens), so the offer
            // carries the preferred mode too.
            vec![CapabilityClass::InvokeThrough, CapabilityClass::Mintable]
        );
        assert_eq!(
            github.source,
            ProbeSource::CliTool {
                binary: "gh".to_string(),
                version: None
            }
        );
    }

    #[test]
    fn presence_without_liveness_is_low_confidence() {
        let bin = FakeBin::with(&["az", "vault", "docker"]);
        let ctx = ctx_with(&bin, MockCommandRunner::new());
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        for provider in ["azure-sm", "vault", "docker"] {
            let offer = offer_for(&items, provider);
            assert_eq!(offer.confidence, Confidence::Low, "{provider}");
            assert_eq!(offer.capabilities, vec![CapabilityClass::InvokeThrough]);
        }
    }

    #[test]
    fn a_failed_liveness_check_degrades_to_presence_only() {
        let bin = FakeBin::with(&["gh"]);
        let commands = MockCommandRunner::new().with_status(
            &["gh", "auth", "token"],
            CommandStatus {
                success: false,
                stdout_non_empty: false,
            },
        );
        let ctx = ctx_with(&bin, commands);
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        assert_eq!(offer_for(&items, "github").confidence, Confidence::Low);
    }

    #[test]
    fn token_printing_checks_require_non_empty_stdout() {
        // `gh auth token` exiting 0 with empty stdout proves nothing.
        let bin = FakeBin::with(&["gh"]);
        let commands = MockCommandRunner::new().with_status(
            &["gh", "auth", "token"],
            CommandStatus {
                success: true,
                stdout_non_empty: false,
            },
        );
        let ctx = ctx_with(&bin, commands);
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        assert_eq!(offer_for(&items, "github").confidence, Confidence::Low);
    }

    #[test]
    fn mint_capability_follows_the_provider_not_the_tool() {
        let bin = FakeBin::with(&["aws", "gcloud", "op", "kubectl"]);
        let commands = MockCommandRunner::new()
            .with_status(
                &["aws", "configure", "list"],
                CommandStatus {
                    success: true,
                    stdout_non_empty: true,
                },
            )
            .with_status(
                &["gcloud", "config", "get-value", "account"],
                CommandStatus {
                    success: true,
                    stdout_non_empty: true,
                },
            )
            .with_status(
                &["op", "account", "list"],
                CommandStatus {
                    success: true,
                    stdout_non_empty: false,
                },
            )
            .with_status(
                &["kubectl", "config", "current-context"],
                CommandStatus {
                    success: true,
                    stdout_non_empty: true,
                },
            );
        let ctx = ctx_with(&bin, commands);
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        for provider in ["aws", "gcp"] {
            assert!(
                offer_for(&items, provider)
                    .capabilities
                    .contains(&CapabilityClass::Mintable),
                "{provider} should be mint-capable"
            );
        }
        for provider in ["1password", "kubernetes"] {
            assert_eq!(
                offer_for(&items, provider).capabilities,
                vec![CapabilityClass::InvokeThrough],
                "{provider} should not be mint-capable"
            );
        }
    }

    #[test]
    fn binaries_not_on_path_produce_no_offers() {
        let bin = FakeBin::with(&[]);
        let ctx = ctx_with(&bin, MockCommandRunner::new());
        let items = CliCapabilityProbe.probe(&ctx).expect("probe");
        assert!(items.is_empty());
    }

    #[test]
    fn every_binary_maps_to_the_documented_provider() {
        let all: Vec<&str> = CLI_TOOLS.iter().map(|tool| tool.binary).collect();
        assert_eq!(
            all,
            [
                "gh",
                "glab",
                "aws",
                "gcloud",
                "az",
                "op",
                "doppler",
                "infisical",
                "kubectl",
                "docker",
                "vault",
                "bao"
            ]
        );
        let expected: &[(&str, &[&str])] = &[
            ("gh", &["github"]),
            ("glab", &["gitlab"]),
            ("aws", &["aws"]),
            ("gcloud", &["gcp"]),
            ("az", &["azure-sm"]),
            ("op", &["1password"]),
            ("doppler", &["doppler"]),
            ("infisical", &["infisical"]),
            ("kubectl", &["kubernetes"]),
            ("docker", &["docker"]),
            ("vault", &["vault"]),
            ("bao", &["openbao"]),
        ];
        for (binary, providers) in expected {
            let tool = CLI_TOOLS
                .iter()
                .find(|tool| tool.binary == *binary)
                .expect(binary);
            assert_eq!(&tool.provider_ids, providers, "{binary}");
        }
    }
}
