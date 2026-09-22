//! How the Host authenticates to Identity's principal-mapping endpoint.
//!
//! Exactly one mode is in force (`OPENSESAME_MAPPING_AUTH`), and there is no
//! chain between them: `shared_secret` sends the dedicated
//! `OPENSESAME_MAPPING_RESOLVE_TOKEN` bearer, `mtls` presents the
//! `OPENSESAME_MAPPING_TLS_*` client certificate and sends **no** bearer at
//! all. A certificate-only deployment must not need an unused secret to boot,
//! and a certificate that fails to load must not quietly become a bearer
//! call — neither the NATS callout secret nor the operator token is ever
//! reachable from here (`identity_mapping_tests::mapping_never_reads_other_secrets`).
//!
//! Every egress fence the bearer profile had is kept by construction: this
//! module only *adds* TLS material to a `reqwest::ClientBuilder` the caller
//! already fenced (no proxy, no redirects, pinned addresses, timeouts).

use opensesame_domain::transport::{TransportError, TrustProfileRef};
use opensesame_transport_security::env::{
    Lookup, NativeIdentitySpec, NativeTrustSpec, ServerExpectation,
};
use opensesame_transport_security::{
    env as tls_env, reqwest_builder, ClientProfile, ServerNamePolicy, TrustBundle,
};

use crate::identity_mapping::MappingClientError;
use crate::transport::config::{AuthMode, MappingTlsConfig, MAPPING_TLS_PREFIX};

/// The one credential the mapping client presents.
#[derive(Clone)]
pub enum MappingAuth {
    /// `OPENSESAME_MAPPING_RESOLVE_TOKEN`.
    Bearer(String),
    /// `OPENSESAME_MAPPING_TLS_*`. Boxed: a profile carries a chain.
    Mtls(Box<ClientProfile>),
}

impl std::fmt::Debug for MappingAuth {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Bearer(_) => "MappingAuth::Bearer(..)",
            Self::Mtls(_) => "MappingAuth::Mtls(..)",
        })
    }
}

impl MappingAuth {
    #[must_use]
    pub const fn is_mtls(&self) -> bool {
        matches!(self, Self::Mtls(_))
    }

    /// The server identity this client will accept, for the endpoint check
    /// that happens before any request leaves the process.
    #[must_use]
    pub fn expected_server_name(&self) -> Option<&str> {
        match self {
            Self::Bearer(_) => None,
            Self::Mtls(profile) => match &profile.server_name {
                ServerNamePolicy::Dns(name) => Some(name.as_str()),
                ServerNamePolicy::SpiffeId(_) => None,
            },
        }
    }

    /// Layer TLS onto an already-fenced builder. The caller's `no_proxy`,
    /// redirect policy, timeouts and resolver pinning are untouched.
    ///
    /// # Errors
    ///
    /// `mapping transport unavailable` when the profile cannot be turned into
    /// a TLS configuration.
    pub fn apply_builder(
        &self,
        base: reqwest::ClientBuilder,
    ) -> Result<reqwest::ClientBuilder, MappingClientError> {
        match self {
            Self::Bearer(_) => Ok(base),
            Self::Mtls(profile) => reqwest_builder(profile, base)
                .map_err(|_| MappingClientError::Http("mapping transport unavailable".into())),
        }
    }

    /// Attach the bearer, or nothing at all under `mtls`.
    #[must_use]
    pub fn apply_request(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match self {
            Self::Bearer(token) => request.bearer_auth(token),
            Self::Mtls(_) => request,
        }
    }

    /// Validate a bearer exactly as the shared-secret profile always did.
    ///
    /// # Errors
    ///
    /// `invalid mapping credential`.
    pub fn bearer(token: String) -> Result<Self, MappingClientError> {
        if token.len() < 32 || token.len() > 4096 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(MappingClientError::Http(
                "invalid mapping credential".into(),
            ));
        }
        Ok(Self::Bearer(token))
    }
}

/// Build the `mtls` profile from the deployment plane.
///
/// # Errors
///
/// `MalformedConfiguration` / `SourceUnsupported` from the loaders; a source
/// other than a PEM file pair is refused here rather than silently ignored.
pub fn client_profile(config: &MappingTlsConfig) -> Result<ClientProfile, TransportError> {
    let identity = match &config.identity {
        NativeIdentitySpec::PemFiles { cert, key } => {
            std::sync::Arc::new(tls_env::read_pem_identity(cert, key)?)
        }
        NativeIdentitySpec::ManagedCertificate { .. } | NativeIdentitySpec::Spiffe { .. } => {
            return Err(TransportError::SourceUnsupported)
        }
    };
    let server_trust = match &config.server_trust {
        NativeTrustSpec::PemFile { path, kind } => {
            let pem = std::fs::read(path)
                .map_err(|e| TransportError::malformed(format!("mapping trust bundle: {e}")))?;
            let bundle =
                TrustBundle::from_pem(TrustProfileRef::new("identity-mapping")?, *kind, &pem)?;
            match &config.crl_file {
                Some(crl) => {
                    let crl_pem = std::fs::read(crl)
                        .map_err(|e| TransportError::malformed(format!("mapping crl file: {e}")))?;
                    bundle.with_crls(&crl_pem)?
                }
                None => bundle,
            }
        }
        NativeTrustSpec::SpiffeTrustDomain { .. } => return Err(TransportError::SourceUnsupported),
    };
    let server_name = match &config.server {
        ServerExpectation::Dns(name) => ServerNamePolicy::Dns(name.clone()),
        ServerExpectation::SpiffeId(id) => ServerNamePolicy::SpiffeId(id.clone()),
    };
    Ok(ClientProfile {
        server_trust,
        server_name,
        identity: Some(identity),
        min_version: config.min_version,
    })
}

/// Resolve the mapping credential for a chosen mode.
///
/// # Errors
///
/// A configured mode whose material is missing or unusable. Never falls back
/// to the other mode.
pub fn resolve(mode: AuthMode, lookup: &Lookup<'_>) -> Result<Option<MappingAuth>, String> {
    match mode {
        AuthMode::Unconfigured => Ok(None),
        AuthMode::SharedSecret => {
            let token = lookup("OPENSESAME_MAPPING_RESOLVE_TOKEN")
                .ok_or_else(|| "mapping credential is required".to_owned())?;
            MappingAuth::bearer(token)
                .map(Some)
                .map_err(|e| e.to_string())
        }
        AuthMode::Mtls => {
            let config = MappingTlsConfig::load(lookup)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("{MAPPING_TLS_PREFIX}_* is required under mtls"))?;
            client_profile(&config)
                .map(|profile| Some(MappingAuth::Mtls(Box::new(profile))))
                .map_err(|e| format!("{}: {e}", e.code()))
        }
    }
}

#[cfg(test)]
#[path = "identity_mapping_tls_tests.rs"]
mod tests;
