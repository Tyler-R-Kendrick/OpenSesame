//! Deployment-plane environment for the bridge binary. Every loader takes a
//! lookup so tests never touch the process environment, and every secret is
//! a *file path*, read once and never echoed.
//!
//! | Variable | Meaning |
//! |---|---|
//! | `OPENSESAME_NATS_URL` (or `NATS_URL`) | server(s) to connect to |
//! | `OPENSESAME_NATS_CALLOUT_CREDS_FILE` / `_NKEY_SEED_FILE` | the bridge user's credentials (one of) |
//! | `OPENSESAME_NATS_CALLOUT_SIGNING_SEED_FILE` | account seed (`SA…`) that signs responses |
//! | `OPENSESAME_NATS_CALLOUT_XKEY_SEED_FILE` | curve seed (`SX…`) when callouts are sealed |
//! | `OPENSESAME_NATS_CALLOUT_TARGET_ACCOUNT` | account name issued users are placed in |
//! | `OPENSESAME_NATS_CALLOUT_SUBJECT` | the callout issuer the server puts in the request's `sub` (operator mode: the account name; unset = the signing account's public key, which is config mode) |
//! | `OPENSESAME_NATS_SERVER_NKEYS` | optional comma list of server keys to pin |
//! | `OPENSESAME_NATS_CALLOUT_MAX_EXP_SECS` | response/user JWT validity (default 300) |
//! | `OPENSESAME_NATS_CALLOUT_HOST_URL` | Host base URL (https) |
//! | `OPENSESAME_CALLOUT_TLS_*` | the bridge's identity + Host trust (CONTRACT §5) |
//! | `OPENSESAME_NATS_TLS_*` | trust (+ optional identity) for the NATS connection |
//! | `OPENSESAME_NATS_CALLOUT_ALLOW_PLAINTEXT_NATS` | `1` permits a NATS URL without TLS (development only) |
//!
//! `OPENSESAME_NATS_TLS_*` is read with `opensesame_transport_security::env`
//! directly rather than through task-bus: at the time of writing task-bus
//! had no resolver for that prefix, and both would produce the same
//! `rustls::ClientConfig` from the same variables, so the bridge does not
//! wait on it.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use opensesame_domain::transport::{TransportError, TrustProfileKind, TrustProfileRef};
use opensesame_transport_security::env::{
    load_identity_from, load_min_version_from, load_server_expectation_from, load_trust_from,
    read_pem_identity, Lookup, NativeIdentitySpec, NativeTrustSpec, ServerExpectation,
};
use opensesame_transport_security::{ClientProfile, ServerNamePolicy, TrustBundle};
use secrecy::{ExposeSecret as _, SecretBox};

use crate::error::{misconfigured, CalloutError};
use crate::response::DEFAULT_EXP_SECS;

/// How the bridge authenticates to NATS.
pub enum NatsAuth {
    Credentials(SecretBox<String>),
    NkeySeed(SecretBox<String>),
}

impl std::fmt::Debug for NatsAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Credentials(_) => "NatsAuth::Credentials(<redacted>)",
            Self::NkeySeed(_) => "NatsAuth::NkeySeed(<redacted>)",
        })
    }
}

/// The resolved bridge configuration. Seeds are read here and handed to the
/// signer/xkey constructors; they are not retained.
pub struct BridgeConfig {
    pub nats_url: String,
    pub nats_auth: NatsAuth,
    /// `None` only when plaintext NATS was explicitly allowed.
    pub nats_tls: Option<ClientProfile>,
    pub signing_seed: SecretBox<String>,
    pub xkey_seed: Option<SecretBox<String>>,
    pub target_account: String,
    pub callout_subject: Option<String>,
    pub server_public_keys: Vec<String>,
    pub max_exp_secs: i64,
    pub host_url: url::Url,
    pub host_tls: ClientProfile,
}

impl std::fmt::Debug for BridgeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeConfig")
            .field("nats_url", &self.nats_url)
            .field("nats_auth", &self.nats_auth)
            .field("nats_tls", &self.nats_tls.is_some())
            .field("target_account", &self.target_account)
            .field("callout_subject", &self.callout_subject)
            .field("pinned_servers", &self.server_public_keys.len())
            .field("max_exp_secs", &self.max_exp_secs)
            .field("host_url", &self.host_url.as_str())
            .finish_non_exhaustive()
    }
}

fn get(lookup: &Lookup<'_>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn expect(lookup: &Lookup<'_>, name: &str) -> Result<String, CalloutError> {
    get(lookup, name).ok_or_else(|| misconfigured(format!("{name} is required")))
}

fn read_secret_file(path: &str) -> Result<SecretBox<String>, CalloutError> {
    let text = std::fs::read_to_string(Path::new(path))
        .map_err(|e| misconfigured(format!("cannot read {path}: {e}")))?;
    Ok(SecretBox::new(Box::new(text)))
}

fn transport(e: TransportError) -> CalloutError {
    misconfigured(format!("transport: {}: {e}", e.code()))
}

/// Build a [`ClientProfile`] for `prefix`. `identity_required` makes a
/// missing `P_IDENTITY_SOURCE` an error.
///
/// # Errors
///
/// `MalformedConfiguration` for missing trust, an unsupported source
/// (managed/SPIFFE are delivered by other components, not read from files
/// here), or material that does not load.
pub fn client_profile_from(
    prefix: &str,
    lookup: &Lookup<'_>,
    identity_required: bool,
) -> Result<Option<ClientProfile>, CalloutError> {
    let Some(trust) = load_trust_from(prefix, lookup).map_err(transport)? else {
        if identity_required {
            return Err(misconfigured(format!("{prefix}_TRUST_FILE is required")));
        }
        return Ok(None);
    };
    let (path, kind) = match trust {
        NativeTrustSpec::PemFile { path, kind } => (path, kind),
        NativeTrustSpec::SpiffeTrustDomain { .. } => {
            return Err(misconfigured(format!(
                "{prefix}: SPIFFE trust is delivered by the Workload API adapter, not a file; use a PEM bundle here"
            )))
        }
    };
    let pem = std::fs::read(&path)
        .map_err(|e| misconfigured(format!("cannot read {}: {e}", path.display())))?;
    let profile_name = prefix.to_ascii_lowercase().replace('_', "-");
    let server_trust = TrustBundle::from_pem(
        TrustProfileRef::new(&profile_name).map_err(transport)?,
        kind,
        &pem,
    )
    .map_err(transport)?;
    let server_name = match load_server_expectation_from(prefix, lookup).map_err(transport)? {
        Some(ServerExpectation::Dns(name)) => ServerNamePolicy::Dns(name),
        Some(ServerExpectation::SpiffeId(id)) => ServerNamePolicy::SpiffeId(id),
        None => {
            return Err(misconfigured(format!(
                "{prefix}_SERVER_NAME or {prefix}_SERVER_SPIFFE_ID is required"
            )))
        }
    };
    if kind == TrustProfileKind::SpiffeTrustDomain
        && matches!(server_name, ServerNamePolicy::Dns(_))
    {
        return Err(misconfigured(format!(
            "{prefix}: a SPIFFE bundle needs {prefix}_SERVER_SPIFFE_ID"
        )));
    }
    let identity = match load_identity_from(prefix, lookup).map_err(transport)? {
        Some(NativeIdentitySpec::PemFiles { cert, key }) => {
            Some(Arc::new(read_pem_identity(&cert, &key).map_err(transport)?))
        }
        Some(_) => {
            return Err(misconfigured(format!(
                "{prefix}: only pem identities are loadable by the bridge binary"
            )))
        }
        None if identity_required => {
            return Err(misconfigured(format!(
                "{prefix}_IDENTITY_SOURCE=pem is required"
            )))
        }
        None => None,
    };
    Ok(Some(ClientProfile {
        server_trust,
        server_name,
        identity,
        min_version: load_min_version_from(prefix, lookup).map_err(transport)?,
    }))
}

impl BridgeConfig {
    /// Read from the process environment.
    ///
    /// # Errors
    ///
    /// As [`Self::from_lookup`].
    pub fn from_env() -> Result<Self, CalloutError> {
        Self::from_lookup(&|name| std::env::var(name).ok())
    }

    /// Read from a lookup.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` naming the first missing or malformed
    /// variable. A bridge with a missing identity or trust does not start.
    pub fn from_lookup(lookup: &Lookup<'_>) -> Result<Self, CalloutError> {
        let nats_url = get(lookup, "OPENSESAME_NATS_URL")
            .or_else(|| get(lookup, "NATS_URL"))
            .ok_or_else(|| misconfigured("OPENSESAME_NATS_URL is required"))?;
        let nats_auth = match (
            get(lookup, "OPENSESAME_NATS_CALLOUT_CREDS_FILE"),
            get(lookup, "OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE"),
        ) {
            (Some(creds), None) => NatsAuth::Credentials(read_secret_file(&creds)?),
            (None, Some(seed)) => NatsAuth::NkeySeed(read_secret_file(&seed)?),
            (None, None) => {
                return Err(misconfigured(
                    "OPENSESAME_NATS_CALLOUT_CREDS_FILE or OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE is required",
                ))
            }
            (Some(_), Some(_)) => {
                return Err(misconfigured(
                    "OPENSESAME_NATS_CALLOUT_CREDS_FILE and OPENSESAME_NATS_CALLOUT_NKEY_SEED_FILE are mutually exclusive",
                ))
            }
        };
        let allow_plaintext =
            get(lookup, "OPENSESAME_NATS_CALLOUT_ALLOW_PLAINTEXT_NATS").as_deref() == Some("1");
        let nats_tls = client_profile_from("OPENSESAME_NATS_TLS", lookup, false)?;
        if nats_tls.is_none() && !allow_plaintext {
            return Err(misconfigured(
                "OPENSESAME_NATS_TLS_TRUST_FILE is required (set OPENSESAME_NATS_CALLOUT_ALLOW_PLAINTEXT_NATS=1 only for local development)",
            ));
        }
        let signing_seed = read_secret_file(&expect(
            lookup,
            "OPENSESAME_NATS_CALLOUT_SIGNING_SEED_FILE",
        )?)?;
        let xkey_seed = get(lookup, "OPENSESAME_NATS_CALLOUT_XKEY_SEED_FILE")
            .map(|p| read_secret_file(&p))
            .transpose()?;
        let target_account = expect(lookup, "OPENSESAME_NATS_CALLOUT_TARGET_ACCOUNT")?;
        let callout_subject = get(lookup, "OPENSESAME_NATS_CALLOUT_SUBJECT");
        let server_public_keys = get(lookup, "OPENSESAME_NATS_SERVER_NKEYS")
            .map(|list| {
                list.split(',')
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for key in &server_public_keys {
            if !key.starts_with('N') || nkeys::KeyPair::from_public_key(key).is_err() {
                return Err(misconfigured(
                    "OPENSESAME_NATS_SERVER_NKEYS must list server public keys (N…)",
                ));
            }
        }
        let max_exp_secs = match get(lookup, "OPENSESAME_NATS_CALLOUT_MAX_EXP_SECS") {
            Some(v) => v.parse::<i64>().map_err(|_| {
                misconfigured("OPENSESAME_NATS_CALLOUT_MAX_EXP_SECS must be an integer")
            })?,
            None => DEFAULT_EXP_SECS,
        };
        let host_url = url::Url::parse(&expect(lookup, "OPENSESAME_NATS_CALLOUT_HOST_URL")?)
            .map_err(|e| misconfigured(format!("OPENSESAME_NATS_CALLOUT_HOST_URL: {e}")))?;
        let host_tls = client_profile_from("OPENSESAME_CALLOUT_TLS", lookup, true)?
            .ok_or_else(|| misconfigured("OPENSESAME_CALLOUT_TLS_* is required"))?;
        Ok(Self {
            nats_url,
            nats_auth,
            nats_tls,
            signing_seed,
            xkey_seed,
            target_account,
            callout_subject,
            server_public_keys,
            max_exp_secs,
            host_url,
            host_tls,
        })
    }

    /// NATS connect options: TLS (required unless plaintext was allowed),
    /// credentials, a name, and no unbounded reconnect storms.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when the credentials file does not parse or
    /// the TLS profile cannot become a client configuration.
    pub fn connect_options(&self) -> Result<async_nats::ConnectOptions, CalloutError> {
        let mut options = async_nats::ConnectOptions::new()
            .name("opensesame-nats-auth-bridge")
            .retry_on_initial_connect();
        options = match &self.nats_auth {
            NatsAuth::Credentials(creds) => options
                .credentials(creds.expose_secret())
                .map_err(|e| misconfigured(format!("callout credentials file: {e}")))?,
            NatsAuth::NkeySeed(seed) => options.nkey(seed.expose_secret().trim().to_owned()),
        };
        if let Some(profile) = &self.nats_tls {
            let config =
                opensesame_transport_security::client_config(profile).map_err(transport)?;
            options = options.tls_client_config(config).require_tls(true);
        }
        Ok(options)
    }
}

/// Write `contents` to `dir/name` with mode 0600 (tests and tooling).
///
/// # Errors
///
/// `MalformedConfiguration` when the file cannot be written.
pub fn write_secret_file(dir: &Path, name: &str, contents: &str) -> Result<PathBuf, CalloutError> {
    let path = dir.join(name);
    std::fs::write(&path, contents).map_err(|e| misconfigured(format!("write {name}: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| misconfigured(format!("chmod {name}: {e}")))?;
    }
    Ok(path)
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
