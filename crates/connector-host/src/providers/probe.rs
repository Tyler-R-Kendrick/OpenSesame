//! Readiness and live probes of a provider's CLI: whether it is installed, and
//! whether it can authenticate. The CLI is run by the trusted rule
//! (`providers/cli.rs`).

use opensesame_domain::ProviderDefinition;
use opensesame_trusted_exec::Lookup;

use super::cli;

#[derive(Clone, Debug, serde::Serialize)]
pub struct ProviderProbe {
    pub available: bool,
    pub adapter: String,
    pub detail: String,
    pub live: bool,
}

/// Harmless local readiness probe. This never reads a secret and never upgrades
/// support status; provider-specific live tests remain a separate evidence gate.
#[must_use]
pub fn probe_local(provider: &ProviderDefinition) -> ProviderProbe {
    probe_local_in(provider, &Lookup::capture())
}

pub(super) fn probe_local_in(provider: &ProviderDefinition, lookup: &Lookup) -> ProviderProbe {
    if provider.adapter == "http:github-app" {
        let has = |name: &str| std::env::var(name).map(|v| !v.is_empty()).unwrap_or(false);
        let configured = has("GITHUB_APP_ID")
            && (has("GITHUB_APP_PRIVATE_KEY") || has("GITHUB_APP_PRIVATE_KEY_PATH"));
        return ProviderProbe {
            available: configured,
            adapter: provider.adapter.clone(),
            detail: if configured {
                "GitHub App credentials configured; lease via opensesame CLI".into()
            } else {
                "set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH to enable".into()
            },
            live: false,
        };
    }
    let Some(executable) = provider.adapter.strip_prefix("cli:") else {
        let builtin = matches!(
            provider.adapter.as_str(),
            "native:human-vault" | "native:e2ee-sync" | "native:env"
        );
        return ProviderProbe {
            available: builtin,
            adapter: provider.adapter.clone(),
            detail: if builtin {
                "built into this OpenSesame host".into()
            } else {
                "live integration probe required".into()
            },
            live: false,
        };
    };
    match cli::output(executable, &["--version"], lookup) {
        Ok(output) => ProviderProbe {
            available: output.status.success(),
            adapter: provider.adapter.clone(),
            detail: if output.status.success() {
                format!("{executable} is installed")
            } else {
                format!("{executable} --version failed")
            },
            live: false,
        },
        Err(error) => ProviderProbe {
            available: false,
            adapter: provider.adapter.clone(),
            detail: format!("{executable} is unavailable: {error}"),
            live: false,
        },
    }
}

/// Harmless authenticated/runtime probe. Output is discarded and never enters
/// logs or the response; a successful result is live evidence for this process,
/// not a permanent support promotion.
#[must_use]
pub fn probe_live(provider: &ProviderDefinition) -> ProviderProbe {
    probe_live_in(provider, &Lookup::capture())
}

pub(super) fn probe_live_in(provider: &ProviderDefinition, lookup: &Lookup) -> ProviderProbe {
    let command: Option<(&str, &[&str])> = match provider.id.as_str() {
        "age" => Some(("age", &["--version"])),
        "aws-kms" | "aws-parameter-store" | "aws-secrets-manager" | "aws-sts" => {
            Some(("aws", &["sts", "get-caller-identity", "--output", "json"]))
        }
        "azure-key-vault-keys"
        | "azure-app-configuration"
        | "azure-key-vault-secrets"
        | "azure-access-token" => Some(("az", &["account", "show", "--output", "none"])),
        "gcp-kms" | "gcp-secret-manager" | "gcp-iam" => {
            Some(("gcloud", &["auth", "print-access-token"]))
        }
        "doppler" => Some(("doppler", &["me"])),
        "vault" => Some(("vault", &["status", "-format=json"])),
        "1password" => Some(("op", &["whoami", "--format=json"])),
        "bitwarden" | "vaultwarden" => Some(("bw", &["sync", "--quiet"])),
        "keychain" if cfg!(target_os = "macos") => Some(("security", &["list-keychains"])),
        "sealed-local" | "encrypted-remote" | "plain" => {
            return ProviderProbe {
                available: true,
                adapter: provider.adapter.clone(),
                detail: "native runtime is ready".into(),
                live: true,
            };
        }
        _ => None,
    };
    let Some((executable, args)) = command else {
        let mut probe = probe_local_in(provider, lookup);
        probe.detail = if probe.available {
            "adapter is ready; no non-secret live probe is implemented".into()
        } else {
            probe.detail
        };
        return probe;
    };
    match cli::succeeds(executable, args, lookup) {
        Ok(true) => ProviderProbe {
            available: true,
            adapter: provider.adapter.clone(),
            detail: "live authentication/runtime probe passed".into(),
            live: true,
        },
        Ok(false) => ProviderProbe {
            available: false,
            adapter: provider.adapter.clone(),
            detail: "live authentication/runtime probe failed".into(),
            live: false,
        },
        Err(_) => ProviderProbe {
            available: false,
            adapter: provider.adapter.clone(),
            detail: format!("{executable} is unavailable"),
            live: false,
        },
    }
}
