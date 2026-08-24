use base64::{engine::general_purpose::STANDARD, Engine};
use opensesame_domain::{
    AuthenticationMode as Auth, ExecutionTarget as Target, ProviderCapability as Capability,
    ProviderCategory as Category, ProviderDefinition, ProviderSupport,
};
use serde_json::Value;
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

const PERSONAL: &[Target] = &[Target::PersonalDaemon];
const WORKLOAD: &[Target] = &[Target::WorkloadWorker];
const BOTH: &[Target] = &[Target::PersonalDaemon, Target::WorkloadWorker];
const SECRET_RW: &[Capability] = &[
    Capability::Read,
    Capability::Write,
    Capability::Delete,
    Capability::List,
    Capability::Test,
];
const CRYPTO: &[Capability] = &[Capability::Encrypt, Capability::Decrypt, Capability::Test];
const LEASE: &[Capability] = &[Capability::Lease, Capability::Revoke, Capability::Test];
const CONTRACT_TESTED: &[&str] = &[
    "age",
    "aws-kms",
    "gcp-kms",
    "aws-parameter-store",
    "aws-secrets-manager",
    "azure-key-vault-secrets",
    "azure-app-configuration",
    "gcp-secret-manager",
    "doppler",
    "bitwarden-secrets-manager",
    "vault",
    "openbao",
    "1password",
    "bitwarden",
    "vaultwarden",
    "infisical",
    "keepass",
    "password-store",
    "sealed-local",
    "encrypted-remote",
    "plain",
    "aws-sts",
    "gcp-iam",
    "azure-access-token",
    "github-oauth",
    "custom-command",
];

#[expect(
    clippy::too_many_arguments,
    reason = "arguments mirror one flat ProviderDefinition catalog row"
)]
fn provider(
    id: &str,
    display_name: &str,
    categories: &[Category],
    capabilities: &[Capability],
    authentication: &[Auth],
    execution_targets: &[Target],
    adapter: &str,
    live_test_environment: &[&str],
) -> ProviderDefinition {
    ProviderDefinition {
        id: id.into(),
        display_name: display_name.into(),
        categories: categories.to_vec(),
        capabilities: capabilities.to_vec(),
        authentication: authentication.to_vec(),
        execution_targets: execution_targets.to_vec(),
        // Promotion is evidence-driven. No provider is advertised as supported
        // until its live environment gate has produced an artifact.
        support: ProviderSupport::Experimental,
        adapter: adapter.into(),
        live_test_environment: live_test_environment.iter().map(|s| (*s).into()).collect(),
    }
}

/// Native `OpenSesame` provider catalog pinned to the fnox documentation snapshot
/// recorded in `connectors/fnox-parity.json`.
#[must_use]
#[expect(
    clippy::too_many_lines,
    reason = "the provider catalog is a cohesive declarative compatibility table"
)]
pub fn catalog() -> Vec<ProviderDefinition> {
    use Auth::{Hardware, HostSession, LocalKeyring, StaticToken, VendorCli, WorkloadIdentity};
    use Category::{
        CloudSecretManager, Encryption, Lease, LocalStorage, PasswordManager, RemoteStorage,
    };
    let mut providers = vec![
        provider(
            "age",
            "age",
            &[Encryption],
            CRYPTO,
            &[VendorCli],
            PERSONAL,
            "cli:age",
            &[],
        ),
        provider(
            "fido2",
            "FIDO2",
            &[Encryption],
            CRYPTO,
            &[Hardware],
            PERSONAL,
            "native:fido2",
            &[],
        ),
        provider(
            "yubikey",
            "YubiKey",
            &[Encryption],
            CRYPTO,
            &[Hardware],
            PERSONAL,
            "cli:ykman",
            &[],
        ),
        provider(
            "aws-kms",
            "AWS KMS",
            &[Encryption],
            CRYPTO,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:aws",
            &["AWS_REGION"],
        ),
        provider(
            "azure-key-vault-keys",
            "Azure Key Vault Keys",
            &[Encryption],
            CRYPTO,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:az",
            &["AZURE_TENANT_ID"],
        ),
        provider(
            "gcp-kms",
            "Google Cloud KMS",
            &[Encryption],
            CRYPTO,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:gcloud",
            &["GOOGLE_CLOUD_PROJECT"],
        ),
        provider(
            "aws-parameter-store",
            "AWS Systems Manager Parameter Store",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:aws",
            &["AWS_REGION"],
        ),
        provider(
            "aws-secrets-manager",
            "AWS Secrets Manager",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:aws",
            &["AWS_REGION"],
        ),
        provider(
            "azure-app-configuration",
            "Azure App Configuration",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:az",
            &["AZURE_TENANT_ID"],
        ),
        provider(
            "azure-key-vault-secrets",
            "Azure Key Vault Secrets",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:az",
            &["AZURE_TENANT_ID"],
        ),
        provider(
            "gcp-secret-manager",
            "Google Cloud Secret Manager",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:gcloud",
            &["GOOGLE_CLOUD_PROJECT"],
        ),
        provider(
            "doppler",
            "Doppler",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, StaticToken],
            BOTH,
            "cli:doppler",
            &["DOPPLER_TOKEN"],
        ),
        provider(
            "foks",
            "FOKS",
            &[Encryption, RemoteStorage],
            &[
                Capability::Read,
                Capability::Write,
                Capability::Sync,
                Capability::Encrypt,
                Capability::Decrypt,
                Capability::Test,
            ],
            &[VendorCli],
            PERSONAL,
            "cli:foks",
            &[],
        ),
        provider(
            "bitwarden-secrets-manager",
            "Bitwarden Secrets Manager",
            &[CloudSecretManager, RemoteStorage],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:bws",
            &["BWS_ACCESS_TOKEN"],
        ),
        provider(
            "vault",
            "HashiCorp Vault",
            &[CloudSecretManager, RemoteStorage, Lease],
            &[
                Capability::Read,
                Capability::Write,
                Capability::Delete,
                Capability::List,
                Capability::Lease,
                Capability::Revoke,
                Capability::Test,
            ],
            &[VendorCli, WorkloadIdentity, StaticToken],
            BOTH,
            "cli:vault",
            &["VAULT_ADDR"],
        ),
        provider(
            "openbao",
            "OpenBao",
            &[CloudSecretManager, RemoteStorage, Lease],
            &[
                Capability::Read,
                Capability::Write,
                Capability::Delete,
                Capability::List,
                Capability::Lease,
                Capability::Revoke,
                Capability::Test,
            ],
            &[WorkloadIdentity, StaticToken],
            BOTH,
            "http:openbao",
            &["OPENSESAME_OPENBAO_URL"],
        ),
        provider(
            "1password",
            "1Password",
            &[PasswordManager],
            SECRET_RW,
            &[VendorCli, HostSession],
            PERSONAL,
            "cli:op",
            &[],
        ),
        provider(
            "bitwarden",
            "Bitwarden",
            &[PasswordManager],
            SECRET_RW,
            &[VendorCli, HostSession],
            PERSONAL,
            "cli:bw",
            &[],
        ),
        provider(
            "vaultwarden",
            "Vaultwarden",
            &[PasswordManager],
            SECRET_RW,
            &[VendorCli, HostSession],
            PERSONAL,
            "cli:bw",
            &["BW_SERVER"],
        ),
        provider(
            "infisical",
            "Infisical",
            &[PasswordManager, CloudSecretManager],
            SECRET_RW,
            &[VendorCli, WorkloadIdentity, StaticToken],
            BOTH,
            "cli:infisical",
            &[],
        ),
        provider(
            "proton-pass",
            "Proton Pass",
            &[PasswordManager],
            SECRET_RW,
            &[VendorCli, HostSession],
            PERSONAL,
            "cli:pass-cli",
            &[],
        ),
        provider(
            "passwordstate",
            "Passwordstate",
            &[PasswordManager],
            SECRET_RW,
            &[StaticToken],
            BOTH,
            "http:passwordstate",
            &["PASSWORDSTATE_URL"],
        ),
        provider(
            "keychain",
            "Operating-system keychain",
            &[LocalStorage],
            SECRET_RW,
            &[LocalKeyring],
            PERSONAL,
            "native:keychain",
            &[],
        ),
        provider(
            "keepass",
            "KeePass",
            &[LocalStorage, PasswordManager],
            SECRET_RW,
            &[VendorCli],
            PERSONAL,
            "cli:keepassxc-cli",
            &[],
        ),
        provider(
            "password-store",
            "pass",
            &[LocalStorage, PasswordManager],
            SECRET_RW,
            &[VendorCli],
            PERSONAL,
            "cli:pass",
            &[],
        ),
        provider(
            "sealed-local",
            "OpenSesame sealed local vault",
            &[Encryption, LocalStorage],
            &[
                Capability::Read,
                Capability::Write,
                Capability::Delete,
                Capability::List,
                Capability::Encrypt,
                Capability::Decrypt,
                Capability::Test,
            ],
            &[HostSession],
            PERSONAL,
            "native:human-vault",
            &[],
        ),
        provider(
            "encrypted-remote",
            "OpenSesame encrypted remote sync",
            &[Encryption, RemoteStorage],
            &[
                Capability::Read,
                Capability::Write,
                Capability::Sync,
                Capability::Encrypt,
                Capability::Decrypt,
                Capability::Test,
            ],
            &[HostSession],
            BOTH,
            "native:e2ee-sync",
            &[],
        ),
        provider(
            "plain",
            "Plain environment/defaults",
            &[LocalStorage],
            &[Capability::Read, Capability::Test],
            &[HostSession],
            PERSONAL,
            "native:env",
            &[],
        ),
        provider(
            "aws-sts",
            "AWS STS",
            &[Lease],
            LEASE,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:aws",
            &["AWS_REGION"],
        ),
        provider(
            "gcp-iam",
            "Google Cloud IAM credentials",
            &[Lease],
            LEASE,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:gcloud",
            &["GOOGLE_CLOUD_PROJECT"],
        ),
        provider(
            "azure-access-token",
            "Azure access token",
            &[Lease],
            LEASE,
            &[VendorCli, WorkloadIdentity],
            BOTH,
            "cli:az",
            &["AZURE_TENANT_ID"],
        ),
        provider(
            "cloudflare-api-token",
            "Cloudflare API token",
            &[Lease],
            LEASE,
            &[StaticToken],
            WORKLOAD,
            "http:cloudflare",
            &["CLOUDFLARE_ACCOUNT_ID"],
        ),
        provider(
            "github-app",
            "GitHub App installation token",
            &[Lease],
            LEASE,
            &[WorkloadIdentity],
            BOTH,
            "http:github-app",
            &[
                "GITHUB_APP_ID",
                "GITHUB_APP_PRIVATE_KEY_PATH",
                "GITHUB_APP_INSTALLATION_ID",
            ],
        ),
        provider(
            "github-oauth",
            "GitHub OAuth token",
            &[Lease],
            LEASE,
            &[HostSession],
            PERSONAL,
            "http:github-oauth",
            &[],
        ),
        provider(
            "custom-command",
            "Custom command lease",
            &[Lease],
            LEASE,
            &[VendorCli],
            PERSONAL,
            "command:human-only",
            &[],
        ),
    ];
    for provider in &mut providers {
        if CONTRACT_TESTED.contains(&provider.id.as_str()) {
            provider.support = ProviderSupport::ContractTested;
        }
    }
    providers
}

#[must_use]
pub fn find(id: &str) -> Option<ProviderDefinition> {
    catalog().into_iter().find(|provider| provider.id == id)
}

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
    match std::process::Command::new(executable)
        .arg("--version")
        .output()
    {
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
        let mut probe = probe_local(provider);
        probe.detail = if probe.available {
            "adapter is ready; no non-secret live probe is implemented".into()
        } else {
            probe.detail
        };
        return probe;
    };
    match command_succeeds(executable, args) {
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

fn command_succeeds(executable: &str, args: &[&str]) -> std::io::Result<bool> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let mut child = std::process::Command::new(executable)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(status.success());
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(false);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HumanProviderOperation {
    Read,
    List,
    Lease,
    Revoke,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HumanProviderPlan {
    Environment(String),
    Command {
        executable: String,
        args: Vec<String>,
    },
    /// In-process sealed store (password-store / sealed-local). Never shells to `pass`.
    SealedStore {
        operation: HumanProviderOperation,
        store_dir: PathBuf,
        name: String,
    },
    /// GitHub App installation-token mint (RS256 app JWT → installation token).
    /// Planned here; executed natively by the human CLI, which owns the signing
    /// and HTTP implementation. Carries the key *path*, never key material.
    /// Unset fields fall back to `GITHUB_APP_*` environment variables at
    /// execution time.
    GitHubApp {
        app_id: Option<String>,
        installation_id: Option<String>,
        private_key_path: Option<String>,
    },
    /// Native Bitwarden / Vaultwarden consume-client read or list.
    ///
    /// Planned here, executed by the human CLI
    /// (`apps/cli/src/providers_native.rs`), which owns the TTY master-password
    /// prompt and the HTTP client — exactly the split the `GitHubApp` variant
    /// already uses. Carries no credential: the master password is prompted at
    /// execution time and never stored, never in argv, never in an env var.
    ///
    /// Returned only when the connection opts in via `native_client` in its
    /// public configuration; otherwise the legacy `bw`-CLI `Command` plan is
    /// returned unchanged.
    Bitwarden {
        server_url: String,
        resource: String,
        operation: HumanProviderOperation,
    },
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProviderExecutionError {
    #[error("provider {0} does not implement this human operation")]
    Unsupported(String),
    #[error("public configuration field {0} is required")]
    MissingConfig(String),
    #[error("provider command is unavailable: {0}")]
    Unavailable(String),
    #[error("provider command failed")]
    Failed,
    #[error("provider output exceeded 10 MiB")]
    OutputTooLarge,
    #[error("provider output was not UTF-8")]
    InvalidOutput,
    #[error("refusing to overwrite existing output {0}")]
    OutputExists(String),
    #[error("provider output could not be written: {0}")]
    WriteFailed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CryptoOperation {
    Encrypt,
    Decrypt,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CryptoPlan {
    pub executable: String,
    pub args: Vec<String>,
    pub output: PathBuf,
    pub stdout_base64: bool,
}

/// # Errors
///
/// Returns an error for an existing output, invalid path, missing provider
/// configuration, or unsupported provider operation.
#[expect(
    clippy::too_many_lines,
    reason = "provider argv construction is a cohesive declarative command table"
)]
pub fn crypto_plan(
    provider_id: &str,
    operation: CryptoOperation,
    input: &Path,
    output: &Path,
    public_config: &Value,
) -> Result<CryptoPlan, ProviderExecutionError> {
    if output.exists() {
        return Err(ProviderExecutionError::OutputExists(
            output.display().to_string(),
        ));
    }
    let input = input
        .to_str()
        .ok_or(ProviderExecutionError::InvalidOutput)?;
    let output_arg = output
        .to_str()
        .ok_or(ProviderExecutionError::InvalidOutput)?;
    let (executable, args, stdout_base64) = match (provider_id, operation) {
        ("age", CryptoOperation::Encrypt) => (
            "age",
            vec![
                "--recipient".into(),
                config(public_config, "recipient")?,
                "--output".into(),
                output_arg.into(),
                input.into(),
            ],
            false,
        ),
        ("age", CryptoOperation::Decrypt) => (
            "age",
            vec![
                "--decrypt".into(),
                "--identity".into(),
                config(public_config, "identity")?,
                "--output".into(),
                output_arg.into(),
                input.into(),
            ],
            false,
        ),
        ("gcp-kms", operation) => (
            "gcloud",
            vec![
                "kms".into(),
                match operation {
                    CryptoOperation::Encrypt => "encrypt".into(),
                    CryptoOperation::Decrypt => "decrypt".into(),
                },
                "--key".into(),
                config(public_config, "key")?,
                "--keyring".into(),
                config(public_config, "keyring")?,
                "--location".into(),
                config(public_config, "location")?,
                "--project".into(),
                config(public_config, "project")?,
                match operation {
                    CryptoOperation::Encrypt => "--plaintext-file".into(),
                    CryptoOperation::Decrypt => "--ciphertext-file".into(),
                },
                input.into(),
                match operation {
                    CryptoOperation::Encrypt => "--ciphertext-file".into(),
                    CryptoOperation::Decrypt => "--plaintext-file".into(),
                },
                output_arg.into(),
            ],
            false,
        ),
        ("aws-kms", CryptoOperation::Encrypt) => (
            "aws",
            vec![
                "kms".into(),
                "encrypt".into(),
                "--key-id".into(),
                config(public_config, "key")?,
                "--plaintext".into(),
                format!("fileb://{input}"),
                "--query".into(),
                "CiphertextBlob".into(),
                "--output".into(),
                "text".into(),
            ],
            true,
        ),
        ("aws-kms", CryptoOperation::Decrypt) => (
            "aws",
            vec![
                "kms".into(),
                "decrypt".into(),
                "--ciphertext-blob".into(),
                format!("fileb://{input}"),
                "--query".into(),
                "Plaintext".into(),
                "--output".into(),
                "text".into(),
            ],
            true,
        ),
        _ => return Err(ProviderExecutionError::Unsupported(provider_id.into())),
    };
    Ok(CryptoPlan {
        executable: executable.into(),
        args,
        output: output.into(),
        stdout_base64,
    })
}

/// # Errors
///
/// Returns an error when execution fails, output is invalid or oversized, or
/// the destination cannot be created securely.
pub fn execute_crypto_plan(plan: CryptoPlan) -> Result<(), ProviderExecutionError> {
    if plan.output.exists() {
        return Err(ProviderExecutionError::OutputExists(
            plan.output.display().to_string(),
        ));
    }
    let output = std::process::Command::new(&plan.executable)
        .args(&plan.args)
        .output()
        .map_err(|_| ProviderExecutionError::Unavailable(plan.executable))?;
    if !output.status.success() {
        return Err(ProviderExecutionError::Failed);
    }
    if plan.stdout_base64 {
        if output.stdout.len() > 10 * 1024 * 1024 {
            return Err(ProviderExecutionError::OutputTooLarge);
        }
        let decoded = STANDARD
            .decode(String::from_utf8_lossy(&output.stdout).trim())
            .map_err(|_| ProviderExecutionError::InvalidOutput)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(0o600);
        }
        options
            .open(&plan.output)
            .and_then(|mut file| file.write_all(&decoded))
            .map_err(|error| ProviderExecutionError::WriteFailed(error.to_string()))?;
    }
    #[cfg(unix)]
    if plan.output.exists() {
        std::fs::set_permissions(&plan.output, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| ProviderExecutionError::WriteFailed(error.to_string()))?;
    }
    if !plan.output.exists() {
        return Err(ProviderExecutionError::WriteFailed(
            "provider did not create the output file".into(),
        ));
    }
    Ok(())
}

fn config(config: &Value, key: &str) -> Result<String, ProviderExecutionError> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ProviderExecutionError::MissingConfig(key.into()))
}

fn config_opt(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
}

/// True when a bitwarden/vaultwarden connection opts in to the native
/// consume-client (`crates/provider-bitwarden`) instead of shelling to `bw`.
///
/// Accepts a JSON boolean or the strings `"true"`/`"1"`, because connection
/// configuration arrives from several editors that stringify booleans.
fn native_client_enabled(config: &Value) -> bool {
    match config.get("native_client") {
        Some(Value::Bool(enabled)) => *enabled,
        Some(Value::String(raw)) => {
            let raw = raw.trim();
            raw.eq_ignore_ascii_case("true") || raw == "1"
        }
        _ => false,
    }
}

/// Build an argv-only provider operation. The resource is always one argument;
/// no shell interprets spaces, quotes, substitutions, or metacharacters in it.
///
/// # Errors
///
/// Returns an error for invalid resources, missing provider configuration, or
/// unsupported provider operations.
#[expect(
    clippy::too_many_lines,
    reason = "provider argv construction is a cohesive declarative command table"
)]
pub fn human_plan(
    provider_id: &str,
    operation: HumanProviderOperation,
    resource: &str,
    public_config: &Value,
) -> Result<HumanProviderPlan, ProviderExecutionError> {
    if resource.is_empty() || resource.contains('\0') {
        return Err(ProviderExecutionError::Unsupported(provider_id.into()));
    }
    let command = |executable: &str, args: Vec<String>| HumanProviderPlan::Command {
        executable: executable.into(),
        args,
    };
    let plan = match (provider_id, operation) {
        ("plain", HumanProviderOperation::Read) => HumanProviderPlan::Environment(resource.into()),
        ("aws-secrets-manager", HumanProviderOperation::Read) => command(
            "aws",
            [
                "secretsmanager",
                "get-secret-value",
                "--secret-id",
                resource,
                "--query",
                "SecretString",
                "--output",
                "text",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        ("aws-secrets-manager", HumanProviderOperation::List) => command(
            "aws",
            [
                "secretsmanager",
                "list-secrets",
                "--query",
                "SecretList[].Name",
                "--output",
                "json",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        ("aws-parameter-store", HumanProviderOperation::Read) => command(
            "aws",
            [
                "ssm",
                "get-parameter",
                "--name",
                resource,
                "--with-decryption",
                "--query",
                "Parameter.Value",
                "--output",
                "text",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        ("aws-parameter-store", HumanProviderOperation::List) => command(
            "aws",
            [
                "ssm",
                "get-parameters-by-path",
                "--path",
                resource,
                "--recursive",
                "--query",
                "Parameters[].Name",
                "--output",
                "json",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ),
        ("azure-key-vault-secrets", HumanProviderOperation::Read) => command(
            "az",
            vec![
                "keyvault".into(),
                "secret".into(),
                "show".into(),
                "--vault-name".into(),
                config(public_config, "vault")?,
                "--name".into(),
                resource.into(),
                "--query".into(),
                "value".into(),
                "--output".into(),
                "tsv".into(),
            ],
        ),
        ("azure-key-vault-secrets", HumanProviderOperation::List) => command(
            "az",
            vec![
                "keyvault".into(),
                "secret".into(),
                "list".into(),
                "--vault-name".into(),
                config(public_config, "vault")?,
                "--query".into(),
                "[].name".into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("azure-app-configuration", HumanProviderOperation::Read) => command(
            "az",
            vec![
                "appconfig".into(),
                "kv".into(),
                "show".into(),
                "--name".into(),
                config(public_config, "store")?,
                "--key".into(),
                resource.into(),
                "--query".into(),
                "value".into(),
                "--output".into(),
                "tsv".into(),
            ],
        ),
        ("azure-app-configuration", HumanProviderOperation::List) => command(
            "az",
            vec![
                "appconfig".into(),
                "kv".into(),
                "list".into(),
                "--name".into(),
                config(public_config, "store")?,
                "--query".into(),
                "[].key".into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("gcp-secret-manager", HumanProviderOperation::Read) => command(
            "gcloud",
            vec![
                "secrets".into(),
                "versions".into(),
                "access".into(),
                "latest".into(),
                "--secret".into(),
                resource.into(),
                "--project".into(),
                config(public_config, "project")?,
            ],
        ),
        ("gcp-secret-manager", HumanProviderOperation::List) => command(
            "gcloud",
            vec![
                "secrets".into(),
                "list".into(),
                "--project".into(),
                config(public_config, "project")?,
                "--format".into(),
                "json(name)".into(),
            ],
        ),
        ("doppler", HumanProviderOperation::Read) => command(
            "doppler",
            vec![
                "secrets".into(),
                "get".into(),
                resource.into(),
                "--plain".into(),
                "--project".into(),
                config(public_config, "project")?,
                "--config".into(),
                config(public_config, "config")?,
            ],
        ),
        ("bitwarden-secrets-manager", HumanProviderOperation::Read) => command(
            "bws",
            vec![
                "secret".into(),
                "get".into(),
                resource.into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("bitwarden-secrets-manager", HumanProviderOperation::List) => command(
            "bws",
            vec![
                "secret".into(),
                "list".into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("vault", HumanProviderOperation::Read) => command(
            "vault",
            vec![
                "kv".into(),
                "get".into(),
                format!("-field={}", config(public_config, "field")?),
                resource.into(),
            ],
        ),
        ("vault", HumanProviderOperation::List) => command(
            "vault",
            vec![
                "kv".into(),
                "list".into(),
                "-format=json".into(),
                resource.into(),
            ],
        ),
        ("openbao", HumanProviderOperation::Read) => command(
            "bao",
            vec![
                "kv".into(),
                "get".into(),
                format!("-field={}", config(public_config, "field")?),
                resource.into(),
            ],
        ),
        ("openbao", HumanProviderOperation::List) => command(
            "bao",
            vec![
                "kv".into(),
                "list".into(),
                "-format=json".into(),
                resource.into(),
            ],
        ),
        ("1password", HumanProviderOperation::Read) => command(
            "op",
            vec!["read".into(), resource.into(), "--no-newline".into()],
        ),
        ("1password", HumanProviderOperation::List) => command(
            "op",
            vec!["item".into(), "list".into(), "--format=json".into()],
        ),
        // Opt-in native path. `native_client` is a deliberate per-connection
        // switch: without it the legacy `bw` shelling below is unchanged, so
        // every existing connection keeps working exactly as it did.
        (
            "bitwarden" | "vaultwarden",
            operation @ (HumanProviderOperation::Read | HumanProviderOperation::List),
        ) if native_client_enabled(public_config) => HumanProviderPlan::Bitwarden {
            server_url: config(public_config, "server_url")?,
            resource: resource.into(),
            operation,
        },
        ("bitwarden" | "vaultwarden", HumanProviderOperation::Read) => command(
            "bw",
            vec![
                "get".into(),
                "password".into(),
                resource.into(),
                "--raw".into(),
            ],
        ),
        ("bitwarden" | "vaultwarden", HumanProviderOperation::List) => {
            command("bw", vec!["list".into(), "items".into(), "--raw".into()])
        }
        ("infisical", HumanProviderOperation::Read) => command(
            "infisical",
            vec![
                "secrets".into(),
                "get".into(),
                resource.into(),
                "--plain".into(),
            ],
        ),
        ("infisical", HumanProviderOperation::List) => {
            command("infisical", vec!["secrets".into(), "--output=json".into()])
        }
        ("keepass", HumanProviderOperation::Read) => command(
            "keepassxc-cli",
            vec![
                "show".into(),
                "--attributes".into(),
                "Password".into(),
                config(public_config, "database")?,
                resource.into(),
            ],
        ),
        ("keepass", HumanProviderOperation::List) => command(
            "keepassxc-cli",
            vec![
                "ls".into(),
                config(public_config, "database")?,
                resource.into(),
            ],
        ),
        ("password-store" | "sealed-local", HumanProviderOperation::Read) => {
            let store_dir = public_config
                .get("store_dir")
                .and_then(Value::as_str)
                .map_or_else(opensesame_sealed_store::resolve_store_dir, PathBuf::from);
            HumanProviderPlan::SealedStore {
                operation: HumanProviderOperation::Read,
                store_dir,
                name: resource.into(),
            }
        }
        ("password-store" | "sealed-local", HumanProviderOperation::List) => {
            let store_dir = public_config
                .get("store_dir")
                .and_then(Value::as_str)
                .map_or_else(opensesame_sealed_store::resolve_store_dir, PathBuf::from);
            HumanProviderPlan::SealedStore {
                operation: HumanProviderOperation::List,
                store_dir,
                name: resource.into(),
            }
        }
        ("keychain", HumanProviderOperation::Read) if cfg!(target_os = "macos") => command(
            "security",
            vec![
                "find-generic-password".into(),
                "-w".into(),
                "-s".into(),
                resource.into(),
            ],
        ),
        ("aws-sts", HumanProviderOperation::Lease) => command(
            "aws",
            vec![
                "sts".into(),
                "assume-role".into(),
                "--role-arn".into(),
                resource.into(),
                "--role-session-name".into(),
                "opensesame-cli".into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("gcp-iam", HumanProviderOperation::Lease) => command(
            "gcloud",
            vec![
                "auth".into(),
                "print-access-token".into(),
                format!("--impersonate-service-account={resource}"),
            ],
        ),
        ("azure-access-token", HumanProviderOperation::Lease) => command(
            "az",
            vec![
                "account".into(),
                "get-access-token".into(),
                "--resource".into(),
                resource.into(),
                "--output".into(),
                "json".into(),
            ],
        ),
        ("vault", HumanProviderOperation::Lease) => command(
            "vault",
            vec!["read".into(), "-format=json".into(), resource.into()],
        ),
        ("vault", HumanProviderOperation::Revoke) => command(
            "vault",
            vec!["lease".into(), "revoke".into(), resource.into()],
        ),
        ("openbao", HumanProviderOperation::Lease) => command(
            "bao",
            vec!["read".into(), "-format=json".into(), resource.into()],
        ),
        ("openbao", HumanProviderOperation::Revoke) => command(
            "bao",
            vec!["lease".into(), "revoke".into(), resource.into()],
        ),
        ("github-oauth", HumanProviderOperation::Lease) => command(
            "gh",
            vec![
                "auth".into(),
                "token".into(),
                "--hostname".into(),
                resource.into(),
            ],
        ),
        // Resource is the installation id, or `auto` to let a single-install
        // app resolve it. Connection config may pin app_id / key path.
        ("github-app", HumanProviderOperation::Lease) => HumanProviderPlan::GitHubApp {
            app_id: config_opt(public_config, "app_id"),
            installation_id: config_opt(public_config, "installation_id")
                .or_else(|| (resource != "auto").then(|| resource.to_string())),
            private_key_path: config_opt(public_config, "private_key_path"),
        },
        ("custom-command", HumanProviderOperation::Lease) => {
            let executable = config(public_config, "executable")?;
            let args = public_config
                .get("args")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(Value::as_str)
                        .map(|arg| arg.replace("{resource}", resource))
                        .collect()
                })
                .unwrap_or_default();
            command(&executable, args)
        }
        _ => return Err(ProviderExecutionError::Unsupported(provider_id.into())),
    };
    Ok(plan)
}

/// Explicit human escape hatch used by the native CLI only. Agent and MCP code
/// have no call path to this function.
///
/// # Errors
///
/// Returns an error when the provider is unavailable, execution fails, or its
/// output is invalid or oversized.
pub fn execute_human_plan(plan: HumanProviderPlan) -> Result<String, ProviderExecutionError> {
    const MAX_OUTPUT: usize = 10 * 1024 * 1024;
    match plan {
        HumanProviderPlan::Environment(name) => std::env::var(&name).map_err(|_| {
            ProviderExecutionError::Unavailable(format!("environment variable {name}"))
        }),
        HumanProviderPlan::Command { executable, args } => {
            let output = std::process::Command::new(&executable)
                .args(args)
                .output()
                .map_err(|_| ProviderExecutionError::Unavailable(executable))?;
            if !output.status.success() {
                return Err(ProviderExecutionError::Failed);
            }
            if output.stdout.len() > MAX_OUTPUT {
                return Err(ProviderExecutionError::OutputTooLarge);
            }
            String::from_utf8(output.stdout)
                .map(|value| value.trim_end_matches(['\r', '\n']).to_owned())
                .map_err(|_| ProviderExecutionError::InvalidOutput)
        }
        HumanProviderPlan::SealedStore {
            operation,
            store_dir,
            name,
        } => execute_sealed_store(operation, &store_dir, &name),
        // The mint needs RS256 signing and GitHub API calls, which live in the
        // CLI (`opensesame lease acquire`). Agent/MCP surfaces reach this arm
        // and are refused — an installation token is human-lease material.
        HumanProviderPlan::GitHubApp { .. } => Err(ProviderExecutionError::Unavailable(
            "github-app leases are minted by the opensesame CLI".into(),
        )),
        // The native Bitwarden client needs an async runtime, a TTY prompt for
        // the master password, and network egress — all of which live in the
        // CLI (`opensesame secret read` / `list`). Agent and MCP surfaces reach
        // this arm and are refused: a vault password is human-plane material.
        HumanProviderPlan::Bitwarden { .. } => Err(ProviderExecutionError::Unavailable(
            "bitwarden/vaultwarden native reads are performed by the opensesame CLI".into(),
        )),
    }
}

fn execute_sealed_store(
    operation: HumanProviderOperation,
    store_dir: &Path,
    name: &str,
) -> Result<String, ProviderExecutionError> {
    match operation {
        HumanProviderOperation::List => {
            let names = opensesame_sealed_store::list_names(store_dir, name).map_err(|e| {
                ProviderExecutionError::Unavailable(format!("sealed-store list: {e}"))
            })?;
            Ok(names.join("\n"))
        }
        HumanProviderOperation::Read => {
            let password = std::env::var("OPENSESAME_STORE_PASSWORD").map_err(|_| {
                ProviderExecutionError::Unavailable(
                    "OPENSESAME_STORE_PASSWORD required to unlock sealed store".into(),
                )
            })?;
            let key = opensesame_sealed_store::unlock_store_key(store_dir, password.as_bytes())
                .map_err(|e| ProviderExecutionError::Unavailable(format!("unlock: {e}")))?;
            let root = opensesame_sealed_store::StoreRoot::open(store_dir)
                .map_err(|e| ProviderExecutionError::Unavailable(format!("open: {e}")))?;
            let age_id = std::env::var("OPENSESAME_AGE_IDENTITY").ok();
            let entry = root
                .show_with_age_identity(name, &key, age_id.as_deref())
                .map_err(|_| ProviderExecutionError::Failed)?;
            Ok(entry.render().trim_end_matches(['\r', '\n']).to_owned())
        }
        HumanProviderOperation::Lease | HumanProviderOperation::Revoke => {
            Err(ProviderExecutionError::Unsupported("sealed-store".into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn catalog_is_unique_and_covers_fnox_snapshot() {
        let providers = catalog();
        let ids: HashSet<_> = providers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), providers.len());
        for required in [
            "age",
            "aws-secrets-manager",
            "azure-key-vault-secrets",
            "gcp-secret-manager",
            "1password",
            "bitwarden",
            "keepass",
            "openbao",
            "sealed-local",
            "aws-sts",
            "github-app",
            "custom-command",
        ] {
            assert!(ids.contains(required), "missing {required}");
        }
        assert!(providers
            .iter()
            .all(|p| p.support != ProviderSupport::Supported));

        let manifest: serde_json::Value =
            serde_json::from_str(include_str!("../../../connectors/fnox-parity.json")).unwrap();
        let required: HashSet<_> = manifest["providers"]
            .as_array()
            .unwrap()
            .iter()
            .chain(manifest["leases"].as_array().unwrap())
            .map(|id| id.as_str().unwrap())
            .collect();
        assert!(required.is_subset(&ids));
    }

    #[test]
    fn human_commands_never_use_a_shell_or_split_the_resource() {
        let resource = "name; echo pwned $(touch nope)";
        let HumanProviderPlan::Command { executable, args } = human_plan(
            "aws-secrets-manager",
            HumanProviderOperation::Read,
            resource,
            &serde_json::json!({}),
        )
        .unwrap() else {
            panic!("expected command");
        };
        assert_eq!(executable, "aws");
        assert!(args.iter().any(|arg| arg == resource));
        assert!(!args.iter().any(|arg| arg == "sh" || arg == "-c"));
    }

    #[test]
    fn bitwarden_without_native_config_still_shells_to_the_bw_cli() {
        for provider in ["bitwarden", "vaultwarden"] {
            let plan = human_plan(
                provider,
                HumanProviderOperation::Read,
                "GitHub",
                &serde_json::json!({ "server_url": "https://vault.example.com" }),
            )
            .unwrap();
            assert_eq!(
                plan,
                HumanProviderPlan::Command {
                    executable: "bw".into(),
                    args: vec![
                        "get".into(),
                        "password".into(),
                        "GitHub".into(),
                        "--raw".into()
                    ],
                },
                "{provider} must keep the legacy plan when native_client is absent"
            );
            let plan = human_plan(
                provider,
                HumanProviderOperation::List,
                "all",
                &serde_json::json!({}),
            )
            .unwrap();
            assert_eq!(
                plan,
                HumanProviderPlan::Command {
                    executable: "bw".into(),
                    args: vec!["list".into(), "items".into(), "--raw".into()],
                }
            );
        }
    }

    #[test]
    fn bitwarden_with_native_config_plans_the_native_client() {
        for provider in ["bitwarden", "vaultwarden"] {
            for enabled in [
                serde_json::json!(true),
                serde_json::json!("true"),
                serde_json::json!("TRUE"),
                serde_json::json!("1"),
            ] {
                let plan = human_plan(
                    provider,
                    HumanProviderOperation::Read,
                    "Work/GitHub",
                    &serde_json::json!({
                        "native_client": enabled,
                        "server_url": "https://vault.example.com",
                    }),
                )
                .unwrap();
                assert_eq!(
                    plan,
                    HumanProviderPlan::Bitwarden {
                        server_url: "https://vault.example.com".into(),
                        resource: "Work/GitHub".into(),
                        operation: HumanProviderOperation::Read,
                    },
                    "{provider} with native_client={enabled}"
                );
            }
            let plan = human_plan(
                provider,
                HumanProviderOperation::List,
                "all",
                &serde_json::json!({
                    "native_client": true,
                    "server_url": "https://vault.example.com",
                }),
            )
            .unwrap();
            assert_eq!(
                plan,
                HumanProviderPlan::Bitwarden {
                    server_url: "https://vault.example.com".into(),
                    resource: "all".into(),
                    operation: HumanProviderOperation::List,
                }
            );
        }
    }

    #[test]
    fn a_native_bitwarden_connection_must_name_its_server() {
        let error = human_plan(
            "bitwarden",
            HumanProviderOperation::Read,
            "GitHub",
            &serde_json::json!({ "native_client": true }),
        )
        .unwrap_err();
        assert_eq!(
            error,
            ProviderExecutionError::MissingConfig("server_url".into())
        );
    }

    #[test]
    fn a_falsey_native_client_flag_keeps_the_cli_path() {
        for flag in [
            serde_json::json!(false),
            serde_json::json!("false"),
            serde_json::json!("no"),
            serde_json::json!(0),
            serde_json::json!(null),
        ] {
            let plan = human_plan(
                "bitwarden",
                HumanProviderOperation::Read,
                "GitHub",
                &serde_json::json!({ "native_client": flag, "server_url": "https://x.example" }),
            )
            .unwrap();
            assert!(
                matches!(plan, HumanProviderPlan::Command { ref executable, .. } if executable == "bw"),
                "native_client={flag} must not opt in"
            );
        }
    }

    #[test]
    fn native_bitwarden_plans_carry_no_credential_material() {
        let plan = human_plan(
            "vaultwarden",
            HumanProviderOperation::Read,
            "GitHub",
            &serde_json::json!({
                "native_client": true,
                "server_url": "https://vault.example.com",
                "session_token": "BW_SESSION-should-never-be-copied",
            }),
        )
        .unwrap();
        let rendered = format!("{plan:?}");
        assert!(
            !rendered.contains("BW_SESSION-should-never-be-copied"),
            "a plan must never carry a secret: {rendered}"
        );
    }

    #[test]
    fn the_sync_executor_refuses_the_native_bitwarden_plan() {
        // Same contract as GitHubApp: the sync executor — the one agent and
        // MCP surfaces can reach — refuses, and only the async CLI call site
        // performs the read.
        let error = execute_human_plan(HumanProviderPlan::Bitwarden {
            server_url: "https://vault.example.com".into(),
            resource: "GitHub".into(),
            operation: HumanProviderOperation::Read,
        })
        .unwrap_err();
        assert!(matches!(error, ProviderExecutionError::Unavailable(ref m) if m.contains("CLI")));
        let github = execute_human_plan(HumanProviderPlan::GitHubApp {
            app_id: None,
            installation_id: None,
            private_key_path: None,
        })
        .unwrap_err();
        assert!(matches!(github, ProviderExecutionError::Unavailable(_)));
    }

    #[test]
    fn crypto_uses_file_arguments_not_plaintext() {
        let plan = crypto_plan(
            "gcp-kms",
            CryptoOperation::Encrypt,
            Path::new("input with spaces.txt"),
            Path::new("output.enc"),
            &serde_json::json!({
                "key": "app",
                "keyring": "prod",
                "location": "global",
                "project": "acme"
            }),
        )
        .unwrap();
        assert_eq!(plan.executable, "gcloud");
        assert!(plan.args.iter().any(|arg| arg == "input with spaces.txt"));
        assert!(!plan.args.iter().any(|arg| arg == "sh" || arg == "-c"));
    }

    /// The agent-facing sealed-store provider must never surface an
    /// attachment — not in a listing, not through a read.
    ///
    /// Nothing in this file enforces that directly. It holds because
    /// `StoreRoot::ls` filters to an extension allowlist that omits
    /// `.osattach`, and because `show` resolves `<name>.osseal`. Both are
    /// decisions made in another crate, either of which could be relaxed by
    /// someone with no idea this boundary depends on them. Documents in a
    /// vault are exactly what ADR 0005 says an agent must not reach, so the
    /// property is pinned here where the agent surface lives.
    #[test]
    fn attachments_are_invisible_to_the_agent_facing_provider() {
        use opensesame_sealed_store::{AttachMeta, Entry, ItemDataKey};

        let dir = tempfile::tempdir().expect("tempdir");
        let store = opensesame_sealed_store::init_store(dir.path(), &[]).expect("init");
        let key = ItemDataKey([5u8; 32]);

        store
            .insert("Dev/token", &Entry::parse("hunter2"), &key)
            .expect("entry");
        let payload = b"a scan of a passport".to_vec();
        let mut source = std::io::Cursor::new(payload.clone());
        store
            .attach_add(
                "Taxes/passport",
                &mut source,
                payload.len() as u64,
                AttachMeta {
                    filename: "passport.pdf".into(),
                    mime: None,
                },
                &key,
                false,
            )
            .expect("attach");

        // List: the entry is visible, the attachment is not — and neither is
        // the object pool that holds its ciphertext.
        let listed =
            execute_sealed_store(HumanProviderOperation::List, dir.path(), "").expect("list");
        assert!(listed.contains("Dev/token"), "entries stay listable: {listed}");
        assert!(
            !listed.contains("Taxes/passport"),
            "an attachment must not appear in the agent-facing listing: {listed}"
        );
        assert!(
            !listed.contains("oschunk") && !listed.contains("osattach") && !listed.contains("attachments"),
            "no attachment artefact may leak into the listing: {listed}"
        );

        // Read: naming the attachment directly must not return it. There is no
        // password set here, so this stops at the unlock — assert on the
        // outcome, not the reason, since either refusal is acceptable.
        assert!(
            execute_sealed_store(HumanProviderOperation::Read, dir.path(), "Taxes/passport")
                .is_err(),
            "an attachment must not be readable through the agent surface"
        );

        // And the plaintext never appears in whatever the provider does return.
        let leaked = String::from_utf8_lossy(&payload).to_string();
        assert!(!listed.contains(&leaked), "plaintext must never surface");
    }

    #[test]
    fn password_store_plan_does_not_shell_to_pass() {
        let plan = human_plan(
            "password-store",
            HumanProviderOperation::List,
            "/",
            &serde_json::json!({"store_dir": "/tmp/store"}),
        )
        .unwrap();
        match plan {
            HumanProviderPlan::Command { executable, .. } => {
                panic!("expected SealedStore, got command {executable}")
            }
            HumanProviderPlan::SealedStore { store_dir, .. } => {
                assert_eq!(store_dir, PathBuf::from("/tmp/store"));
            }
            other => panic!("unexpected plan {other:?}"),
        }
    }

    #[test]
    fn github_app_plan_is_native_and_never_carries_key_material() {
        let plan = human_plan(
            "github-app",
            HumanProviderOperation::Lease,
            "12345678",
            &serde_json::json!({
                "app_id": "424242",
                "private_key_path": "/keys/app.pem"
            }),
        )
        .unwrap();
        match &plan {
            HumanProviderPlan::GitHubApp {
                app_id,
                installation_id,
                private_key_path,
            } => {
                assert_eq!(app_id.as_deref(), Some("424242"));
                assert_eq!(installation_id.as_deref(), Some("12345678"));
                // The plan names a file; the PEM itself must never enter a plan.
                assert_eq!(private_key_path.as_deref(), Some("/keys/app.pem"));
            }
            other => panic!("unexpected plan {other:?}"),
        }
        // connector-host itself refuses to execute it — the CLI owns the mint,
        // so no agent/MCP surface can reach a token through this crate.
        assert!(matches!(
            execute_human_plan(plan),
            Err(ProviderExecutionError::Unavailable(_))
        ));
    }

    #[test]
    fn github_app_auto_resource_defers_installation_resolution() {
        let plan = human_plan(
            "github-app",
            HumanProviderOperation::Lease,
            "auto",
            &serde_json::json!({}),
        )
        .unwrap();
        match plan {
            HumanProviderPlan::GitHubApp {
                installation_id, ..
            } => assert!(installation_id.is_none()),
            other => panic!("unexpected plan {other:?}"),
        }
    }

    #[test]
    fn native_live_probe_never_returns_material() {
        let probe = probe_live(&find("sealed-local").unwrap());
        assert!(probe.available && probe.live);
        assert!(!probe.detail.to_ascii_lowercase().contains("secret"));
    }
}
