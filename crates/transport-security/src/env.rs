//! Deployment-plane environment (CONTRACT §5). Native only; never read by a
//! browser build. Every loader has a `_from` twin that takes a lookup
//! closure so tests never touch the process environment.
//!
//! Prefixes: `OPENSESAME_TLS` (Host listener), `OPENSESAME_MAPPING_TLS`,
//! `OPENSESAME_NATS_TLS`, `OPENSESAME_WORKER_TLS`, `OPENSESAME_CALLOUT_TLS`,
//! `OPENSESAME_CONNECTOR_TLS`.

use std::net::SocketAddr;
use std::path::PathBuf;

use opensesame_domain::transport::{TlsVersion, TransportError, TransportPolicy, TrustProfileKind};

use crate::error::malformed;

/// Where a native identity comes from. A reference, never material.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NativeIdentitySpec {
    PemFiles {
        cert: PathBuf,
        key: PathBuf,
    },
    ManagedCertificate {
        certificate_id: String,
    },
    Spiffe {
        spiffe_id: String,
        endpoint_socket: PathBuf,
    },
}

/// Where the bundle used to verify the peer comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NativeTrustSpec {
    PemFile {
        path: PathBuf,
        kind: TrustProfileKind,
    },
    SpiffeTrustDomain {
        trust_domain: String,
        endpoint_socket: PathBuf,
    },
}

/// A client's expectation of the server: exactly one of the two.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ServerExpectation {
    Dns(String),
    SpiffeId(String),
}

/// The common (unprefixed) deployment variables.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TransportEnv {
    pub listen: Option<SocketAddr>,
    pub policy: Option<TransportPolicy>,
    pub spiffe_endpoint_socket: Option<PathBuf>,
    pub service_bindings_file: Option<PathBuf>,
    pub ingress_originating_trust_file: Option<PathBuf>,
}

/// A lookup over the environment: `None` for unset or empty.
pub type Lookup<'a> = dyn Fn(&str) -> Option<String> + 'a;

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn get(lookup: &Lookup<'_>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn expect(lookup: &Lookup<'_>, name: &str) -> Result<String, TransportError> {
    get(lookup, name).ok_or_else(|| malformed(format!("{name} is required")))
}

fn spiffe_socket(lookup: &Lookup<'_>) -> Result<PathBuf, TransportError> {
    expect(lookup, "OPENSESAME_SPIFFE_ENDPOINT_SOCKET").map(PathBuf::from)
}

impl TransportEnv {
    /// Read from the process environment.
    ///
    /// # Errors
    ///
    /// As [`Self::from_lookup`].
    pub fn from_env() -> Result<Self, TransportError> {
        Self::from_lookup(&process_env)
    }

    /// Read from a lookup.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for an unparseable listen address or an
    /// unknown policy word.
    pub fn from_lookup(lookup: &Lookup<'_>) -> Result<Self, TransportError> {
        let listen = get(lookup, "OPENSESAME_TLS_LISTEN")
            .map(|v| {
                v.parse::<SocketAddr>()
                    .map_err(|e| malformed(format!("OPENSESAME_TLS_LISTEN: {e}")))
            })
            .transpose()?;
        let policy = get(lookup, "OPENSESAME_TLS_POLICY")
            .map(|v| match v.as_str() {
                "server_tls" => Ok(TransportPolicy::ServerTls),
                "mtls_required" => Ok(TransportPolicy::MtlsRequired),
                "trusted_ingress" => Ok(TransportPolicy::TrustedIngress),
                other => Err(malformed(format!(
                    "OPENSESAME_TLS_POLICY: {other:?} is not server_tls|mtls_required|trusted_ingress"
                ))),
            })
            .transpose()?;
        Ok(Self {
            listen,
            policy,
            spiffe_endpoint_socket: get(lookup, "OPENSESAME_SPIFFE_ENDPOINT_SOCKET")
                .map(PathBuf::from),
            service_bindings_file: get(lookup, "OPENSESAME_SERVICE_BINDINGS_FILE")
                .map(PathBuf::from),
            ingress_originating_trust_file: get(
                lookup,
                "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE",
            )
            .map(PathBuf::from),
        })
    }
}

/// `P_IDENTITY_SOURCE` and its companions.
///
/// # Errors
///
/// `MalformedConfiguration` for an unknown source word or a missing
/// companion variable.
pub fn load_identity(prefix: &str) -> Result<Option<NativeIdentitySpec>, TransportError> {
    load_identity_from(prefix, &process_env)
}

/// [`load_identity`] over a lookup.
///
/// # Errors
///
/// As [`load_identity`].
pub fn load_identity_from(
    prefix: &str,
    lookup: &Lookup<'_>,
) -> Result<Option<NativeIdentitySpec>, TransportError> {
    let var = |suffix: &str| format!("{prefix}_{suffix}");
    let Some(source) = get(lookup, &var("IDENTITY_SOURCE")) else {
        return Ok(None);
    };
    let spec = match source.as_str() {
        "pem" => NativeIdentitySpec::PemFiles {
            cert: expect(lookup, &var("CERT_FILE"))?.into(),
            key: expect(lookup, &var("KEY_FILE"))?.into(),
        },
        "managed" => NativeIdentitySpec::ManagedCertificate {
            certificate_id: expect(lookup, &var("MANAGED_CERTIFICATE_ID"))?,
        },
        "spiffe" => NativeIdentitySpec::Spiffe {
            spiffe_id: expect(lookup, &var("SPIFFE_ID"))?,
            endpoint_socket: spiffe_socket(lookup)?,
        },
        other => {
            return Err(malformed(format!(
                "{}: {other:?} is not pem|managed|spiffe",
                var("IDENTITY_SOURCE")
            )))
        }
    };
    Ok(Some(spec))
}

/// `P_TRUST_FILE` + `P_TRUST_KIND`, or `P_TRUST_DOMAIN` for SPIFFE.
///
/// # Errors
///
/// `MalformedConfiguration` for an unknown kind, a SPIFFE kind without a
/// domain or socket, or a file kind without a file.
pub fn load_trust(prefix: &str) -> Result<Option<NativeTrustSpec>, TransportError> {
    load_trust_from(prefix, &process_env)
}

/// [`load_trust`] over a lookup.
///
/// # Errors
///
/// As [`load_trust`].
pub fn load_trust_from(
    prefix: &str,
    lookup: &Lookup<'_>,
) -> Result<Option<NativeTrustSpec>, TransportError> {
    let var = |suffix: &str| format!("{prefix}_{suffix}");
    let kind = get(lookup, &var("TRUST_KIND"));
    let file = get(lookup, &var("TRUST_FILE"));
    let domain = get(lookup, &var("TRUST_DOMAIN"));
    match kind.as_deref() {
        None if file.is_none() && domain.is_none() => Ok(None),
        None => Err(malformed(format!("{} is required", var("TRUST_KIND")))),
        Some("spiffe_trust_domain") => Ok(Some(NativeTrustSpec::SpiffeTrustDomain {
            trust_domain: domain
                .ok_or_else(|| malformed(format!("{} is required", var("TRUST_DOMAIN"))))?,
            endpoint_socket: spiffe_socket(lookup)?,
        })),
        Some(word @ ("webpki_dns" | "private_root")) => Ok(Some(NativeTrustSpec::PemFile {
            path: file
                .ok_or_else(|| malformed(format!("{} is required", var("TRUST_FILE"))))?
                .into(),
            kind: if word == "webpki_dns" {
                TrustProfileKind::WebPkiDns
            } else {
                TrustProfileKind::PrivateRoot
            },
        })),
        Some(other) => Err(malformed(format!(
            "{}: {other:?} is not webpki_dns|private_root|spiffe_trust_domain",
            var("TRUST_KIND")
        ))),
    }
}

/// `P_SERVER_NAME` xor `P_SERVER_SPIFFE_ID`.
///
/// # Errors
///
/// `MalformedConfiguration` when both are set.
pub fn load_server_expectation_from(
    prefix: &str,
    lookup: &Lookup<'_>,
) -> Result<Option<ServerExpectation>, TransportError> {
    let name = get(lookup, &format!("{prefix}_SERVER_NAME"));
    let spiffe = get(lookup, &format!("{prefix}_SERVER_SPIFFE_ID"));
    match (name, spiffe) {
        (None, None) => Ok(None),
        (Some(name), None) => Ok(Some(ServerExpectation::Dns(name.to_ascii_lowercase()))),
        (None, Some(id)) => Ok(Some(ServerExpectation::SpiffeId(id))),
        (Some(_), Some(_)) => Err(malformed(format!(
            "{prefix}_SERVER_NAME and {prefix}_SERVER_SPIFFE_ID are mutually exclusive"
        ))),
    }
}

/// `P_MIN_VERSION`: `1.3` (default) or `1.2`.
///
/// # Errors
///
/// `MalformedConfiguration` for any other word.
pub fn load_min_version_from(
    prefix: &str,
    lookup: &Lookup<'_>,
) -> Result<TlsVersion, TransportError> {
    match get(lookup, &format!("{prefix}_MIN_VERSION")).as_deref() {
        None | Some("1.3") => Ok(TlsVersion::Tls13),
        Some("1.2") => Ok(TlsVersion::Tls12),
        Some(other) => Err(malformed(format!(
            "{prefix}_MIN_VERSION: {other:?} is not 1.3|1.2"
        ))),
    }
}

/// `P_CRL_FILE`, optional.
#[must_use]
pub fn load_crl_file_from(prefix: &str, lookup: &Lookup<'_>) -> Option<PathBuf> {
    get(lookup, &format!("{prefix}_CRL_FILE")).map(PathBuf::from)
}

/// Read a PEM identity from disk. The key file is read into a
/// [`crate::SecretBytes`] and dropped after parsing.
///
/// # Errors
///
/// `MalformedConfiguration` when a file cannot be read; otherwise as
/// [`crate::TlsIdentity::from_pem`].
pub fn read_pem_identity(
    cert: &std::path::Path,
    key: &std::path::Path,
) -> Result<crate::TlsIdentity, TransportError> {
    let chain = std::fs::read(cert).map_err(|e| malformed(format!("certificate file: {e}")))?;
    let key_bytes = std::fs::read(key).map_err(|e| malformed(format!("key file: {e}")))?;
    let secret = crate::SecretBytes::new(Box::new(key_bytes));
    crate::TlsIdentity::from_pem(&chain, &secret)
}
