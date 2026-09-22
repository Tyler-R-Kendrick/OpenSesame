//! Deployment-plane configuration for the source.
//!
//! The Workload API endpoint is reachable only through
//! [`ENDPOINT_SOCKET_ENV`] (`OPENSESAME_SPIFFE_ENDPOINT_SOCKET`) or a native
//! identity spec the runtime already holds. There is deliberately no way to
//! build a [`SpiffeSourceConfig`] from JSON, an HTTP request, browser
//! settings, a connection object, or a certificate extension: the type does
//! not implement `Deserialize`, has no `FromStr`, and its only constructors
//! take an already-privileged path.

use std::path::{Path, PathBuf};
use std::time::Duration;

use opensesame_transport_security::NativeIdentitySpec;
use spiffe::SpiffeId;

use crate::error::SpiffeSourceError;
use crate::outage::ReconnectPolicy;
use crate::svid_profile::SvidRole;

/// The one environment variable that names the Workload API socket.
pub const ENDPOINT_SOCKET_ENV: &str = "OPENSESAME_SPIFFE_ENDPOINT_SOCKET";
/// Default bound on how long a generation outlives a broken stream.
pub const DEFAULT_MAX_STALE: Duration = Duration::from_secs(5 * 60);

/// How this workload reaches its Workload API and which SVID it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpiffeSourceConfig {
    spiffe_id: String,
    trust_domain: String,
    endpoint_socket: PathBuf,
    max_stale: Duration,
    reconnect: ReconnectPolicy,
    role: SvidRole,
}

impl SpiffeSourceConfig {
    /// Build from values the deployment plane holds: the exact SPIFFE ID to
    /// select and the absolute unix socket path of the Workload API.
    ///
    /// # Errors
    /// The SPIFFE ID must be canonical with a non-root path; the socket must
    /// be an absolute filesystem path — `unix:`/`tcp:` URIs are refused so a
    /// remote endpoint can never be smuggled in as a "path".
    pub fn deployment_plane(
        spiffe_id: &str,
        endpoint_socket: impl Into<PathBuf>,
    ) -> Result<Self, SpiffeSourceError> {
        let id = SpiffeId::new(spiffe_id)
            .map_err(|_| SpiffeSourceError::Config("spiffe_id is not a valid SPIFFE ID".into()))?;
        if id.to_string() != spiffe_id {
            return Err(SpiffeSourceError::Config(
                "spiffe_id must be in canonical form".into(),
            ));
        }
        if id.path().is_empty() {
            return Err(SpiffeSourceError::Config(
                "spiffe_id must name a workload path, not a trust-domain root".into(),
            ));
        }
        let endpoint_socket = endpoint_socket.into();
        validate_socket_path(&endpoint_socket)?;
        Ok(Self {
            spiffe_id: id.to_string(),
            trust_domain: id.trust_domain().to_string(),
            endpoint_socket,
            max_stale: DEFAULT_MAX_STALE,
            reconnect: ReconnectPolicy::default(),
            role: SvidRole::Client,
        })
    }

    /// From a native identity spec the runtime already holds (the
    /// deployment-plane loader's output). `Ok(None)` for any other source.
    ///
    /// # Errors
    /// As [`Self::deployment_plane`].
    pub fn from_native_spec(spec: &NativeIdentitySpec) -> Result<Option<Self>, SpiffeSourceError> {
        match spec {
            NativeIdentitySpec::Spiffe {
                spiffe_id,
                endpoint_socket,
            } => Self::deployment_plane(spiffe_id, endpoint_socket.clone()).map(Some),
            NativeIdentitySpec::PemFiles { .. } | NativeIdentitySpec::ManagedCertificate { .. } => {
                Ok(None)
            }
        }
    }

    /// Read `<prefix>_IDENTITY_SOURCE=spiffe`, `<prefix>_SPIFFE_ID` and
    /// [`ENDPOINT_SOCKET_ENV`] from the process environment.
    ///
    /// # Errors
    /// `Ok(None)` when the identity source is not `spiffe`; an error when it
    /// is but the ID or socket is missing or invalid.
    pub fn from_env(prefix: &str) -> Result<Option<Self>, SpiffeSourceError> {
        Self::from_env_with(prefix, |name| std::env::var(name).ok())
    }

    /// [`Self::from_env`] over an explicit lookup; the seam tests use.
    ///
    /// # Errors
    /// As [`Self::from_env`].
    pub fn from_env_with(
        prefix: &str,
        lookup: impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, SpiffeSourceError> {
        let source = lookup(&format!("{prefix}_IDENTITY_SOURCE"));
        if source.as_deref().map(str::trim) != Some("spiffe") {
            return Ok(None);
        }
        let id_var = format!("{prefix}_SPIFFE_ID");
        let spiffe_id = lookup(&id_var)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| SpiffeSourceError::Config(format!("{id_var} is required")))?;
        let socket = lookup(ENDPOINT_SOCKET_ENV)
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                SpiffeSourceError::Config(format!("{ENDPOINT_SOCKET_ENV} is required"))
            })?;
        Self::deployment_plane(spiffe_id.trim(), PathBuf::from(socket.trim())).map(Some)
    }

    /// Bound how long a generation may outlive a broken stream (clamped by
    /// `not_after` regardless).
    #[must_use]
    pub const fn with_max_stale(mut self, max_stale: Duration) -> Self {
        self.max_stale = max_stale;
        self
    }

    /// Reconnect schedule.
    ///
    /// # Errors
    /// An impossible policy (see [`ReconnectPolicy::validate`]).
    pub fn with_reconnect(mut self, reconnect: ReconnectPolicy) -> Result<Self, SpiffeSourceError> {
        reconnect.validate().map_err(SpiffeSourceError::Config)?;
        self.reconnect = reconnect;
        Ok(self)
    }

    /// The TLS role the selected SVID will take (default: client).
    #[must_use]
    pub const fn with_role(mut self, role: SvidRole) -> Self {
        self.role = role;
        self
    }

    /// Exact SPIFFE ID this source selects.
    #[must_use]
    pub fn spiffe_id(&self) -> &str {
        &self.spiffe_id
    }

    /// Trust domain of the selected SPIFFE ID.
    #[must_use]
    pub fn trust_domain(&self) -> &str {
        &self.trust_domain
    }

    /// Unix socket path of the Workload API.
    #[must_use]
    pub fn endpoint_socket(&self) -> &Path {
        &self.endpoint_socket
    }

    /// Outage retention bound.
    #[must_use]
    pub const fn max_stale(&self) -> Duration {
        self.max_stale
    }

    /// Reconnect schedule.
    #[must_use]
    pub const fn reconnect(&self) -> ReconnectPolicy {
        self.reconnect
    }

    /// TLS role.
    #[must_use]
    pub const fn role(&self) -> SvidRole {
        self.role
    }
}

fn validate_socket_path(path: &Path) -> Result<(), SpiffeSourceError> {
    let text = path
        .to_str()
        .ok_or_else(|| SpiffeSourceError::Config("endpoint socket path must be UTF-8".into()))?;
    if let Some((scheme, _)) = text.split_once(':') {
        if !scheme.is_empty() && scheme.chars().all(|c| c.is_ascii_alphabetic()) {
            return Err(SpiffeSourceError::Config(format!(
                "endpoint socket must be a filesystem path, not a `{scheme}:` URI"
            )));
        }
    }
    if !path.is_absolute() {
        return Err(SpiffeSourceError::Config(
            "endpoint socket must be an absolute path".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;
