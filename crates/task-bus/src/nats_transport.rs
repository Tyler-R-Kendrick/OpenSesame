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

use opensesame_domain::transport::{TransportError, TrustProfileKind};
use opensesame_transport_security::{NativeIdentitySpec, NativeTrustSpec};

use crate::nats_policy::{
    NatsAuth, NatsServerName, NatsTransport, NatsTransportPolicy, NatsTransportPublic,
    NatsTransportSource, NatsTransportView,
};
use crate::nats_transport_env::{malformed, url_hosts};

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
            .field("max_reconnects", &self.max_reconnects)
            .field("locators", &"<redacted>")
            .finish()
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

    /// The public, persistable part.
    #[must_use]
    pub fn public(&self) -> NatsTransportPublic {
        NatsTransportPublic {
            transport: self.transport.clone(),
            auth: self.auth.clone(),
        }
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
            if self.transport.client_identity.is_some()
                || self.auth != NatsAuth::None
                || self.transport.tls_first
            {
                return Err(TransportError::PolicyDowngradeRefused);
            }
            return Ok(self);
        }
        let trust = self
            .transport
            .server_trust
            .as_ref()
            .ok_or(TransportError::TrustUnknown)?;
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
                    return Err(malformed(
                        "a DNS server name needs a webpki_dns or private_root trust bundle",
                    ));
                }
                if let Some((_, host)) = hosts.iter().find(|(_, h)| !h.eq_ignore_ascii_case(name)) {
                    return Err(malformed(format!(
                        "server name {name:?} is not the dialed host {host:?}; the verifier checks the dialed name"
                    )));
                }
            }
            Some(NatsServerName::SpiffeId(_)) => {
                if trust.kind != TrustProfileKind::SpiffeTrustDomain {
                    return Err(malformed(
                        "a SPIFFE server identity needs a spiffe_trust_domain bundle",
                    ));
                }
            }
            None => unreachable!("server_name set above"),
        }
        Ok(self)
    }
}
