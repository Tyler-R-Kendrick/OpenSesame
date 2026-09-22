//! Reading the `OPENSESAME_NATS_*` deployment variables into a
//! [`NatsTransportSpec`], and parsing the server list out of a NATS URL.
//!
//! This is the only place a path, a seed file or a credentials file is named.
//! Everything it produces is either a private locator (never serialized) or a
//! public reference (`TrustRef` / `IdentityRef` / `NatsAuth`).

use std::path::PathBuf;

use opensesame_domain::transport::{IdentitySourceKind, TransportError, TrustProfileKind};
use opensesame_transport_security::env::{self as tls_env, Lookup, ServerExpectation};
use opensesame_transport_security::{NativeIdentitySpec, NativeTrustSpec};

use crate::nats_policy::{
    IdentityRef, NatsAuth, NatsServerName, NatsTransport, NatsTransportSource, TrustRef,
};
use crate::nats_transport::{Locators, NatsTransportSpec};

const ENV_PREFIX: &str = "OPENSESAME_NATS";

fn truthy(value: Option<&str>) -> bool {
    matches!(value.map(str::trim), Some("1" | "true" | "yes" | "on"))
}

fn get(lookup: &Lookup<'_>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

pub(crate) fn malformed(message: impl Into<String>) -> TransportError {
    TransportError::MalformedConfiguration(message.into())
}

fn auth_from(
    lookup: &Lookup<'_>,
    prefix: &str,
) -> Result<Option<(NatsAuth, PathBuf)>, TransportError> {
    let seed_var = format!("{prefix}_NKEY_SEED_FILE");
    let creds_var = format!("{prefix}_CREDS_FILE");
    match get(lookup, &format!("{prefix}_AUTH")).as_deref() {
        None | Some("none") => Ok(None),
        Some("nkey") => {
            let path = get(lookup, &seed_var)
                .ok_or_else(|| malformed(format!("{seed_var} is required")))?;
            Ok(Some((
                NatsAuth::Nkey { seed_ref: seed_var },
                PathBuf::from(path),
            )))
        }
        Some("creds") => {
            let path = get(lookup, &creds_var)
                .ok_or_else(|| malformed(format!("{creds_var} is required")))?;
            Ok(Some((
                NatsAuth::Creds {
                    path_ref: creds_var,
                },
                PathBuf::from(path),
            )))
        }
        Some(other) => Err(malformed(format!(
            "{prefix}_AUTH: {other:?} is not none|nkey|creds"
        ))),
    }
}

impl NatsTransportSpec {
    /// Read the `OPENSESAME_NATS_*` deployment variables. `None` when no
    /// transport variable is set, so callers can fall back to stored policy.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a missing companion or an unknown word.
    pub fn from_env() -> Result<Option<Self>, TransportError> {
        Self::from_lookup(ENV_PREFIX, &process_env)
    }

    /// [`Self::from_env`] with an explicit prefix and lookup (tests).
    ///
    /// # Errors
    ///
    /// As [`Self::from_env`].
    pub fn from_lookup(prefix: &str, lookup: &Lookup<'_>) -> Result<Option<Self>, TransportError> {
        let tls = format!("{prefix}_TLS");
        let identity = tls_env::load_identity_from(&tls, lookup)?;
        let trust = tls_env::load_trust_from(&tls, lookup)?;
        let server = tls_env::load_server_expectation_from(&tls, lookup)?;
        let min_version = tls_env::load_min_version_from(&tls, lookup)?;
        let crl_file = tls_env::load_crl_file_from(&tls, lookup);
        let require_flag = get(lookup, &format!("{prefix}_REQUIRE_TLS"));
        let first_flag = get(lookup, &format!("{prefix}_TLS_FIRST"));
        let auth = auth_from(lookup, prefix)?;
        let provision = auth_from(lookup, &format!("{prefix}_PROVISION"))?;
        let max_reconnects = get(lookup, &format!("{prefix}_MAX_RECONNECTS"))
            .map(|v| {
                v.parse::<usize>()
                    .map_err(|e| malformed(format!("{prefix}_MAX_RECONNECTS: {e}")))
            })
            .transpose()?;

        let anything = identity.is_some()
            || trust.is_some()
            || server.is_some()
            || require_flag.is_some()
            || first_flag.is_some()
            || auth.is_some()
            || get(lookup, &format!("{prefix}_AUTH")).is_some();
        if !anything {
            return Ok(None);
        }

        let tls_first = truthy(first_flag.as_deref());
        let require_tls = truthy(require_flag.as_deref())
            || tls_first
            || identity.is_some()
            || trust.is_some()
            || auth.is_some();
        let trust_name =
            get(lookup, &format!("{tls}_TRUST_NAME")).unwrap_or_else(|| "nats-server-trust".into());
        let identity_name =
            get(lookup, &format!("{tls}_IDENTITY_NAME")).unwrap_or_else(|| "nats-client".into());
        let transport = NatsTransport {
            require_tls,
            tls_first,
            server_trust: trust.as_ref().map(|t| TrustRef {
                name: trust_name.clone(),
                kind: trust_kind(t),
            }),
            server_name: server.map(|s| match s {
                ServerExpectation::Dns(name) => NatsServerName::Dns(name),
                ServerExpectation::SpiffeId(id) => NatsServerName::SpiffeId(id),
            }),
            client_identity: identity.as_ref().map(|i| IdentityRef {
                name: identity_name.clone(),
                kind: identity_kind(i),
            }),
            min_version,
        };
        let (auth_public, auth_path) = match auth {
            Some((public, path)) => (public, Some(path)),
            None => (NatsAuth::None, None),
        };
        let (nkey_seed_file, creds_file) = match &auth_public {
            NatsAuth::Nkey { .. } => (auth_path, None),
            NatsAuth::Creds { .. } => (None, auth_path),
            NatsAuth::None => (None, None),
        };
        Ok(Some(Self {
            transport,
            auth: auth_public,
            source: NatsTransportSource::Env,
            max_reconnects,
            locators: Locators {
                identity,
                trust,
                crl_file,
                nkey_seed_file,
                creds_file,
                provision,
            },
        }))
    }
}

fn trust_kind(spec: &NativeTrustSpec) -> TrustProfileKind {
    match spec {
        NativeTrustSpec::PemFile { kind, .. } => *kind,
        NativeTrustSpec::SpiffeTrustDomain { .. } => TrustProfileKind::SpiffeTrustDomain,
    }
}

fn identity_kind(spec: &NativeIdentitySpec) -> IdentitySourceKind {
    match spec {
        NativeIdentitySpec::PemFiles { .. } => IdentitySourceKind::PemFiles,
        NativeIdentitySpec::ManagedCertificate { .. } => IdentitySourceKind::ManagedCertificate,
        NativeIdentitySpec::Spiffe { .. } => IdentitySourceKind::SpiffeWorkloadApi,
    }
}

/// `(scheme, host)` for every comma-separated server in the URL list.
///
/// # Errors
///
/// `MalformedConfiguration` when an entry is not `nats://`/`tls://host[:port]`.
pub fn url_hosts(nats_url: &str) -> Result<Vec<(String, String)>, TransportError> {
    let mut out = Vec::new();
    for raw in nats_url.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        crate::validate_nats_url(raw).map_err(malformed)?;
        let (scheme, rest) = raw
            .split_once("://")
            .ok_or_else(|| malformed("nats_url has no scheme"))?;
        let authority = rest.split('/').next().unwrap_or_default();
        let host = if let Some(stripped) = authority.strip_prefix('[') {
            stripped.split(']').next().unwrap_or_default().to_owned()
        } else {
            authority
                .rsplit_once(':')
                .map_or(authority, |(h, _)| h)
                .to_owned()
        };
        if host.is_empty() {
            return Err(malformed("nats_url has no host"));
        }
        out.push((scheme.to_ascii_lowercase(), host));
    }
    if out.is_empty() {
        return Err(malformed("nats_url is empty"));
    }
    Ok(out)
}
