//! NATS client transport policy: what the Host *requires* of the broker
//! connection (TLS, server identity, client identity, credentials), as
//! references to deployment-plane material — never the material itself.
//!
//! Three shapes, deliberately separate:
//! - [`NatsTransport`] / [`NatsAuth`] — public policy, storable in `host_kv`
//!   and returned to operators. Booleans, profile *names*, a server name, a
//!   TLS floor. No path, seed, key or token can be expressed here.
//! - [`NatsTransportSpec`] — the policy plus the private locators the
//!   deployment plane supplied (`OPENSESAME_NATS_*` env). `Debug` redacts
//!   the locators; it is never serialized.
//! - [`NatsTransportView`] — what status endpoints show: the public policy
//!   plus derived facts (`policy`, `source`).
//!
//! A `tls://` URL, a trust bundle, a client identity or credentials each
//! imply `require_tls`: upgrades are implicit, downgrades never are.

use std::path::PathBuf;

use opensesame_domain::transport::{IdentitySourceKind, TransportError, TrustProfileKind};
use opensesame_transport_security::env::{self as tls_env, Lookup, ServerExpectation};
use opensesame_transport_security::{NativeIdentitySpec, NativeTrustSpec};

use crate::nats_policy::{
    IdentityRef, NatsAuth, NatsServerName, NatsTransport, NatsTransportPolicy, NatsTransportPublic,
    NatsTransportSource, NatsTransportView, TrustRef,
};

/// Private locators from the deployment plane.
#[derive(Clone, Default)]
pub(crate) struct Locators {
    pub identity: Option<NativeIdentitySpec>,
    pub trust: Option<NativeTrustSpec>,
    pub crl_file: Option<PathBuf>,
    pub nkey_seed_file: Option<PathBuf>,
    pub creds_file: Option<PathBuf>,
    /// Separate credential for the one-time provisioning action.
    pub provision: Option<(NatsAuth, PathBuf)>,
}

/// Resolved transport: public policy + private locators.
#[derive(Clone)]
pub struct NatsTransportSpec {
    pub transport: NatsTransport,
    pub auth: NatsAuth,
    pub source: NatsTransportSource,
    pub max_reconnects: Option<usize>,
    pub(crate) locators: Locators,
}

impl std::fmt::Debug for NatsTransportSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NatsTransportSpec")
            .field("transport", &self.transport)
            .field("auth", &self.auth)
            .field("source", &self.source)
            .field("locators", &"<redacted>")
            .finish()
    }
}

const ENV_PREFIX: &str = "OPENSESAME_NATS";

fn truthy(value: Option<String>) -> bool {
    matches!(
        value.as_deref().map(str::trim),
        Some("1" | "true" | "yes" | "on")
    )
}

fn get(lookup: &Lookup<'_>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

fn malformed(message: impl Into<String>) -> TransportError {
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
            let path = get(lookup, &seed_var).ok_or_else(|| malformed(format!("{seed_var} is required")))?;
            Ok(Some((NatsAuth::Nkey { seed_ref: seed_var }, PathBuf::from(path))))
        }
        Some("creds") => {
            let path = get(lookup, &creds_var).ok_or_else(|| malformed(format!("{creds_var} is required")))?;
            Ok(Some((NatsAuth::Creds { path_ref: creds_var }, PathBuf::from(path))))
        }
        Some(other) => Err(malformed(format!("{prefix}_AUTH: {other:?} is not none|nkey|creds"))),
    }
}

impl NatsTransportSpec {
    /// The legacy loopback profile: plaintext, no credentials.
    #[must_use]
    pub fn plaintext() -> Self {
        Self {
            transport: NatsTransport::default(),
            auth: NatsAuth::None,
            source: NatsTransportSource::Default,
            max_reconnects: None,
            locators: Locators::default(),
        }
    }

    /// A stored public policy with no deployment material behind it. A
    /// policy that requires material this process was not given fails at
    /// connect (`trust_unknown` / `identity_missing`), never silently.
    #[must_use]
    pub fn from_public(public: NatsTransportPublic, source: NatsTransportSource) -> Self {
        Self {
            transport: public.transport,
            auth: public.auth,
            source,
            max_reconnects: None,
            locators: Locators::default(),
        }
    }

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
            .map(|v| v.parse::<usize>().map_err(|e| malformed(format!("{prefix}_MAX_RECONNECTS: {e}"))))
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

        let tls_first = truthy(first_flag);
        let require_tls = truthy(require_flag)
            || tls_first
            || identity.is_some()
            || trust.is_some()
            || auth.is_some();
        let trust_name = get(lookup, &format!("{tls}_TRUST_NAME")).unwrap_or_else(|| "nats-server-trust".into());
        let identity_name = get(lookup, &format!("{tls}_IDENTITY_NAME")).unwrap_or_else(|| "nats-client".into());
        let transport = NatsTransport {
            require_tls,
            tls_first,
            server_trust: trust.as_ref().map(|t| TrustRef { name: trust_name.clone(), kind: trust_kind(t) }),
            server_name: server.map(|s| match s {
                ServerExpectation::Dns(name) => NatsServerName::Dns(name),
                ServerExpectation::SpiffeId(id) => NatsServerName::SpiffeId(id),
            }),
            client_identity: identity.as_ref().map(|i| IdentityRef { name: identity_name.clone(), kind: identity_kind(i) }),
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
            locators: Locators { identity, trust, crl_file, nkey_seed_file, creds_file, provision },
        }))
    }

    /// The public, persistable part.
    #[must_use]
    pub fn public(&self) -> NatsTransportPublic {
        NatsTransportPublic { transport: self.transport.clone(), auth: self.auth.clone() }
    }

    /// TLS is required (server-authenticated at least).
    #[must_use]
    pub fn is_secure(&self) -> bool {
        self.transport.require_tls
    }

    /// The derived policy word.
    #[must_use]
    pub fn policy(&self) -> NatsTransportPolicy {
        if !self.transport.require_tls {
            NatsTransportPolicy::Plaintext
        } else if self.transport.client_identity.is_some() {
            NatsTransportPolicy::MtlsRequired
        } else {
            NatsTransportPolicy::ServerTls
        }
    }

    /// The status view. Contains no locator.
    #[must_use]
    pub fn view(&self) -> NatsTransportView {
        NatsTransportView {
            policy: self.policy(),
            source: self.source,
            require_tls: self.transport.require_tls,
            tls_first: self.transport.tls_first,
            server_trust: self.transport.server_trust.clone(),
            server_name: self.transport.server_name.clone(),
            client_identity: self.transport.client_identity.clone(),
            min_version: self.transport.min_version,
            auth: self.auth.kind().to_owned(),
            discovery_ignored: self.transport.require_tls,
        }
    }

    /// The spec to use for the one-time provisioning action: the same
    /// transport with the provisioner credential when one is configured.
    #[must_use]
    pub fn for_provisioning(&self) -> Self {
        let mut spec = self.clone();
        if let Some((auth, path)) = &self.locators.provision {
            spec.auth = auth.clone();
            spec.locators.nkey_seed_file = None;
            spec.locators.creds_file = None;
            match auth {
                NatsAuth::Nkey { .. } => spec.locators.nkey_seed_file = Some(path.clone()),
                NatsAuth::Creds { .. } => spec.locators.creds_file = Some(path.clone()),
                NatsAuth::None => {}
            }
        }
        spec
    }

    /// Apply the URL's implications (`tls://` requires TLS) and check the
    /// policy is internally consistent for these servers.
    ///
    /// # Errors
    ///
    /// - `PolicyDowngradeRefused`: credentials or an identity on a plaintext
    ///   profile, or a `nats://` host beside a `tls://` one.
    /// - `TrustUnknown`: TLS required with no server trust reference.
    /// - `MalformedConfiguration`: a server name that is not the dialed host
    ///   (the client library sends SNI for the dialed host and the verifier
    ///   checks that name; the two must agree), an IP host with no SPIFFE
    ///   policy, or a SPIFFE policy on a non-SPIFFE bundle.
    pub fn normalized(mut self, nats_url: &str) -> Result<Self, TransportError> {
        let hosts = url_hosts(nats_url)?;
        let any_tls = hosts.iter().any(|(scheme, _)| scheme == "tls");
        let any_plain = hosts.iter().any(|(scheme, _)| scheme != "tls");
        if any_tls {
            self.transport.require_tls = true;
        }
        if self.transport.require_tls && any_plain && any_tls {
            return Err(TransportError::PolicyDowngradeRefused);
        }
        if !self.transport.require_tls {
            if self.transport.client_identity.is_some() || self.auth != NatsAuth::None || self.transport.tls_first {
                return Err(TransportError::PolicyDowngradeRefused);
            }
            return Ok(self);
        }
        let trust = self.transport.server_trust.as_ref().ok_or(TransportError::TrustUnknown)?;
        if self.transport.server_name.is_none() {
            let (_, host) = &hosts[0];
            if host.parse::<std::net::IpAddr>().is_ok() {
                return Err(malformed(
                    "a TLS profile dialing an IP literal needs OPENSESAME_NATS_TLS_SERVER_NAME or _SERVER_SPIFFE_ID",
                ));
            }
            self.transport.server_name = Some(NatsServerName::Dns(host.to_ascii_lowercase()));
        }
        match self.transport.server_name.as_ref() {
            Some(NatsServerName::Dns(name)) => {
                if trust.kind == TrustProfileKind::SpiffeTrustDomain {
                    return Err(malformed("a DNS server name needs a webpki_dns or private_root trust bundle"));
                }
                if let Some((_, host)) = hosts.iter().find(|(_, h)| !h.eq_ignore_ascii_case(name)) {
                    return Err(malformed(format!(
                        "server name {name:?} is not the dialed host {host:?}; the verifier checks the dialed name"
                    )));
                }
            }
            Some(NatsServerName::SpiffeId(_)) => {
                if trust.kind != TrustProfileKind::SpiffeTrustDomain {
                    return Err(malformed("a SPIFFE server identity needs a spiffe_trust_domain bundle"));
                }
            }
            None => unreachable!("server_name set above"),
        }
        Ok(self)
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
        let (scheme, rest) = raw.split_once("://").ok_or_else(|| malformed("nats_url has no scheme"))?;
        let authority = rest.split('/').next().unwrap_or_default();
        let host = if let Some(stripped) = authority.strip_prefix('[') {
            stripped.split(']').next().unwrap_or_default().to_owned()
        } else {
            authority.rsplit_once(':').map_or(authority, |(h, _)| h).to_owned()
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
