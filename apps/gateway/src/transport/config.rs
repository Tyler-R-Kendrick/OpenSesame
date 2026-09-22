//! Deployment-plane transport configuration for the Host (CONTRACT §5).
//!
//! Every choice is explicit: a listener policy is a word, not a boolean;
//! the mapping and callout authentication modes are `shared_secret` or
//! `mtls`, inferred only when exactly one kind of material is present and
//! refused as ambiguous when both are. Nothing here reads a file — that is
//! [`super::runtime`]'s job, so a certificate that fails to *load* is a
//! startup error there and never reads as "legacy mode" here.

use std::net::SocketAddr;
use std::path::PathBuf;

use opensesame_domain::transport::{
    BindingPurpose, TlsVersion, TransportError, TransportPolicy, TrustProfileKind,
    TrustProfileRef,
};
use opensesame_transport_security::env::{
    self, Lookup, NativeIdentitySpec, NativeTrustSpec, ServerExpectation, TransportEnv,
};

pub const HOST_TLS_PREFIX: &str = "OPENSESAME_TLS";
pub const MAPPING_TLS_PREFIX: &str = "OPENSESAME_MAPPING_TLS";
pub const MAPPING_AUTH_VAR: &str = "OPENSESAME_MAPPING_AUTH";
pub const MAPPING_TOKEN_VAR: &str = "OPENSESAME_MAPPING_RESOLVE_TOKEN";
pub const CALLOUT_AUTH_VAR: &str = "OPENSESAME_NATS_CALLOUT_AUTH";
pub const CALLOUT_SECRET_VAR: &str = "OPENSESAME_NATS_CALLOUT_SECRET";
pub const CLIENT_TRUST_PROFILE_VAR: &str = "OPENSESAME_TLS_CLIENT_TRUST_PROFILE";
pub const DEFAULT_CLIENT_TRUST_PROFILE: &str = "client_ca";

/// How a service caller authenticates to an endpoint. Never a fallback
/// chain: exactly one mode is in force per consumer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthMode {
    Unconfigured,
    SharedSecret,
    Mtls,
}

impl AuthMode {
    fn parse(var: &str, word: &str) -> Result<Self, TransportError> {
        match word {
            "shared_secret" => Ok(Self::SharedSecret),
            "mtls" => Ok(Self::Mtls),
            other => Err(TransportError::malformed(format!(
                "{var}: {other:?} is not shared_secret|mtls"
            ))),
        }
    }
}

/// The Host's secure listener.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListenerConfig {
    pub listen: SocketAddr,
    pub policy: TransportPolicy,
    pub identity: NativeIdentitySpec,
    /// Required for `mtls_required` / `trusted_ingress`; refused for `server_tls`.
    pub client_trust: Option<NativeTrustSpec>,
    /// The `trust_profile` name bindings refer to for peers of this listener.
    pub client_trust_profile: TrustProfileRef,
    pub crl_file: Option<PathBuf>,
    pub min_version: TlsVersion,
    /// Required for `trusted_ingress`: the bundle originating clients chain to.
    pub ingress_originating_trust_file: Option<PathBuf>,
}

/// The Host's client identity toward the Identity mapping endpoint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MappingTlsConfig {
    pub identity: NativeIdentitySpec,
    pub server_trust: NativeTrustSpec,
    pub server: ServerExpectation,
    pub min_version: TlsVersion,
    pub crl_file: Option<PathBuf>,
}

impl MappingTlsConfig {
    /// Load `OPENSESAME_MAPPING_TLS_*`. `Ok(None)` when no identity source is
    /// named at all.
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` when an identity is named without the trust
    /// bundle or the server expectation, or any loader refuses a value.
    pub fn load(lookup: &Lookup<'_>) -> Result<Option<Self>, TransportError> {
        let Some(identity) = env::load_identity_from(MAPPING_TLS_PREFIX, lookup)? else {
            return Ok(None);
        };
        let server_trust = env::load_trust_from(MAPPING_TLS_PREFIX, lookup)?.ok_or_else(|| {
            TransportError::malformed(format!(
                "{MAPPING_TLS_PREFIX}_TRUST_FILE/_TRUST_KIND is required with a mapping identity"
            ))
        })?;
        let server = env::load_server_expectation_from(MAPPING_TLS_PREFIX, lookup)?
            .ok_or_else(|| {
                TransportError::malformed(format!(
                    "{MAPPING_TLS_PREFIX}_SERVER_NAME or _SERVER_SPIFFE_ID is required"
                ))
            })?;
        Ok(Some(Self {
            identity,
            server_trust,
            server,
            min_version: env::load_min_version_from(MAPPING_TLS_PREFIX, lookup)?,
            crl_file: env::load_crl_file_from(MAPPING_TLS_PREFIX, lookup),
        }))
    }
}

/// Everything the Host's transport reads from the deployment plane.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransportConfig {
    pub listener: Option<ListenerConfig>,
    pub service_bindings_file: Option<PathBuf>,
    pub mapping_auth: AuthMode,
    /// Present exactly when `mapping_auth` is `Mtls`.
    pub mapping_tls: Option<MappingTlsConfig>,
    pub callout_auth: AuthMode,
    pub spiffe_endpoint_socket: Option<PathBuf>,
}

fn get(lookup: &Lookup<'_>, name: &str) -> Option<String> {
    lookup(name)
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn process_env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

impl TransportConfig {
    /// Read the process environment.
    ///
    /// # Errors
    ///
    /// As [`Self::from_lookup`].
    pub fn from_env() -> Result<Self, TransportError> {
        Self::from_lookup(&process_env)
    }

    /// Read from a lookup (tests never touch the process environment).
    ///
    /// # Errors
    ///
    /// `MalformedConfiguration` for a listener without a policy, a policy
    /// without a listener, an authenticating policy without client trust,
    /// client trust under `server_tls`, `trusted_ingress` without the
    /// originating trust file, both mapping credentials without
    /// `OPENSESAME_MAPPING_AUTH`, an explicit mode without its material, or
    /// callout `mtls` without an authenticating listener;
    /// `IdentityMissing` for a listener with no identity source;
    /// `TrustUnknown` for an authenticating listener with no client bundle.
    pub fn from_lookup(lookup: &Lookup<'_>) -> Result<Self, TransportError> {
        let common = TransportEnv::from_lookup(lookup)?;
        let listener = listener_from(&common, lookup)?;
        let (mapping_auth, mapping_tls) = mapping_from(lookup)?;
        let callout_auth = callout_from(lookup, listener.as_ref())?;
        Ok(Self {
            listener,
            service_bindings_file: common.service_bindings_file,
            mapping_auth,
            mapping_tls,
            callout_auth,
            spiffe_endpoint_socket: common.spiffe_endpoint_socket,
        })
    }

    /// Whether a purpose is configured to arrive over authenticated TLS only.
    /// A request for such a purpose on the plain listener is a policy
    /// mismatch, not a fallback (AT-TLS-PLAINTEXT).
    #[must_use]
    pub fn requires_mtls(&self, purpose: BindingPurpose) -> bool {
        let listener_policy = self.listener.as_ref().map(|l| l.policy);
        match purpose {
            BindingPurpose::NatsAuthBridge => self.callout_auth == AuthMode::Mtls,
            BindingPurpose::TrustedIngress => listener_policy == Some(TransportPolicy::TrustedIngress),
            BindingPurpose::ServiceProbe => listener_policy.is_some_and(TransportPolicy::authenticates_client),
            // The Host is the *client* toward Identity and has no worker or
            // upstream-connector receiver of its own.
            BindingPurpose::WorkerClient
            | BindingPurpose::IdentityMappingClient
            | BindingPurpose::UpstreamConnector => false,
        }
    }

    /// True when the Identity mapping client must exist at boot: a mode was
    /// chosen for it, or the callout route (which needs it) is configured.
    #[must_use]
    pub fn mapping_client_required(&self) -> bool {
        self.mapping_auth != AuthMode::Unconfigured || self.callout_auth != AuthMode::Unconfigured
    }
}

fn listener_from(
    common: &TransportEnv,
    lookup: &Lookup<'_>,
) -> Result<Option<ListenerConfig>, TransportError> {
    let (listen, policy) = match (common.listen, common.policy) {
        (None, None) => return Ok(None),
        (Some(_), None) => {
            return Err(TransportError::malformed(
                "OPENSESAME_TLS_POLICY is required with OPENSESAME_TLS_LISTEN",
            ))
        }
        (None, Some(_)) => {
            return Err(TransportError::malformed(
                "OPENSESAME_TLS_LISTEN is required with OPENSESAME_TLS_POLICY",
            ))
        }
        (Some(listen), Some(policy)) => (listen, policy),
    };
    let identity = env::load_identity_from(HOST_TLS_PREFIX, lookup)?
        .ok_or(TransportError::IdentityMissing)?;
    let client_trust = env::load_trust_from(HOST_TLS_PREFIX, lookup)?;
    match (policy.authenticates_client(), &client_trust) {
        (true, None) => return Err(TransportError::TrustUnknown),
        (true, Some(NativeTrustSpec::PemFile { kind: TrustProfileKind::WebPkiDns, .. })) => {
            return Err(TransportError::malformed(
                "OPENSESAME_TLS_TRUST_KIND=webpki_dns cannot authenticate clients",
            ))
        }
        (false, Some(_)) => {
            return Err(TransportError::malformed(
                "server_tls verifies no client; remove OPENSESAME_TLS_TRUST_* or choose mtls_required",
            ))
        }
        _ => {}
    }
    if matches!(identity, NativeIdentitySpec::Spiffe { .. })
        && !matches!(client_trust, Some(NativeTrustSpec::SpiffeTrustDomain { .. }))
    {
        return Err(TransportError::malformed(
            "a spiffe listener identity requires OPENSESAME_TLS_TRUST_KIND=spiffe_trust_domain",
        ));
    }
    let ingress_originating_trust_file = common.ingress_originating_trust_file.clone();
    if policy == TransportPolicy::TrustedIngress && ingress_originating_trust_file.is_none() {
        return Err(TransportError::malformed(
            "OPENSESAME_INGRESS_ORIGINATING_TRUST_FILE is required for trusted_ingress",
        ));
    }
    let client_trust_profile = match &client_trust {
        Some(NativeTrustSpec::SpiffeTrustDomain { trust_domain, .. }) => {
            TrustProfileRef::new(trust_domain.as_str())?
        }
        _ => TrustProfileRef::new(
            get(lookup, CLIENT_TRUST_PROFILE_VAR)
                .unwrap_or_else(|| DEFAULT_CLIENT_TRUST_PROFILE.to_owned()),
        )?,
    };
    Ok(Some(ListenerConfig {
        listen,
        policy,
        identity,
        client_trust,
        client_trust_profile,
        crl_file: env::load_crl_file_from(HOST_TLS_PREFIX, lookup),
        min_version: env::load_min_version_from(HOST_TLS_PREFIX, lookup)?,
        ingress_originating_trust_file,
    }))
}

fn mapping_from(
    lookup: &Lookup<'_>,
) -> Result<(AuthMode, Option<MappingTlsConfig>), TransportError> {
    let token = get(lookup, MAPPING_TOKEN_VAR).is_some();
    let tls = MappingTlsConfig::load(lookup)?;
    let explicit = get(lookup, MAPPING_AUTH_VAR)
        .map(|w| AuthMode::parse(MAPPING_AUTH_VAR, &w))
        .transpose()?;
    let mode = match (explicit, token, tls.is_some()) {
        (Some(mode), _, _) => mode,
        (None, true, true) => {
            return Err(TransportError::malformed(format!(
                "{MAPPING_TOKEN_VAR} and {MAPPING_TLS_PREFIX}_* are both set; {MAPPING_AUTH_VAR} must choose"
            )))
        }
        (None, true, false) => AuthMode::SharedSecret,
        (None, false, true) => AuthMode::Mtls,
        (None, false, false) => AuthMode::Unconfigured,
    };
    match mode {
        AuthMode::SharedSecret if !token => Err(TransportError::malformed(format!(
            "{MAPPING_AUTH_VAR}=shared_secret requires {MAPPING_TOKEN_VAR}"
        ))),
        AuthMode::Mtls if tls.is_none() => Err(TransportError::IdentityMissing),
        AuthMode::Mtls => Ok((mode, tls)),
        AuthMode::SharedSecret | AuthMode::Unconfigured => Ok((mode, None)),
    }
}

fn callout_from(
    lookup: &Lookup<'_>,
    listener: Option<&ListenerConfig>,
) -> Result<AuthMode, TransportError> {
    let secret = get(lookup, CALLOUT_SECRET_VAR).is_some();
    let explicit = get(lookup, CALLOUT_AUTH_VAR)
        .map(|w| AuthMode::parse(CALLOUT_AUTH_VAR, &w))
        .transpose()?;
    let mode = match explicit {
        Some(mode) => mode,
        None if secret => AuthMode::SharedSecret,
        None => AuthMode::Unconfigured,
    };
    match mode {
        AuthMode::SharedSecret if !secret => Err(TransportError::malformed(format!(
            "{CALLOUT_AUTH_VAR}=shared_secret requires {CALLOUT_SECRET_VAR}"
        ))),
        AuthMode::Mtls if secret => Err(TransportError::malformed(format!(
            "{CALLOUT_SECRET_VAR} must be unset under {CALLOUT_AUTH_VAR}=mtls; there is no fallback"
        ))),
        AuthMode::Mtls if !listener.is_some_and(|l| l.policy.authenticates_client()) => {
            Err(TransportError::malformed(format!(
                "{CALLOUT_AUTH_VAR}=mtls requires OPENSESAME_TLS_LISTEN with an authenticating OPENSESAME_TLS_POLICY"
            )))
        }
        mode => Ok(mode),
    }
}
