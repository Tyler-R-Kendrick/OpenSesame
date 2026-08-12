use opensesame_domain::{
    AuthenticationMode as Auth, ExecutionTarget as Target, ProviderCapability as Capability,
    ProviderCategory as Category, ProviderDefinition, ProviderSupport,
};
use serde_json::Value;
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

/// Native OpenSesame provider catalog pinned to the fnox documentation snapshot
/// recorded in `connectors/fnox-parity.json`.
pub fn catalog() -> Vec<ProviderDefinition> {
    use Auth::*;
    use Category::*;
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
            &["GITHUB_APP_ID"],
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
    for provider in &mut providers {
        if CONTRACT_TESTED.contains(&provider.id.as_str()) {
            provider.support = ProviderSupport::ContractTested;
        }
    }
    providers
}

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
pub fn probe_local(provider: &ProviderDefinition) -> ProviderProbe {
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
        use base64::{engine::general_purpose::STANDARD, Engine};
        use std::io::Write;
        let decoded = STANDARD
            .decode(String::from_utf8_lossy(&output.stdout).trim())
            .map_err(|_| ProviderExecutionError::InvalidOutput)?;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&plan.output)
            .and_then(|mut file| file.write_all(&decoded))
            .map_err(|error| ProviderExecutionError::WriteFailed(error.to_string()))?;
    }
    #[cfg(unix)]
    if plan.output.exists() {
        use std::os::unix::fs::PermissionsExt;
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

/// Build an argv-only provider operation. The resource is always one argument;
/// no shell interprets spaces, quotes, substitutions, or metacharacters in it.
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
        ("password-store", HumanProviderOperation::Read) => {
            command("pass", vec!["show".into(), resource.into()])
        }
        ("password-store", HumanProviderOperation::List) => {
            command("pass", vec!["ls".into(), resource.into()])
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

    #[test]
    fn native_live_probe_never_returns_material() {
        let probe = probe_live(&find("sealed-local").unwrap());
        assert!(probe.available && probe.live);
        assert!(!probe.detail.to_ascii_lowercase().contains("secret"));
    }
}
