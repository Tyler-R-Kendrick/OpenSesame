//! Non-secret, stable reason codes for everything this source can refuse.

use opensesame_domain::TransportError;

use crate::svid_profile::SvidProfileError;

/// Why the source could not turn a Workload API message into a usable
/// generation, or could not be configured at all.
///
/// Every variant maps onto a [`TransportError`] code through
/// [`SpiffeSourceError::to_transport_error`]; the mapping is the contract the
/// generation manager and the status surface see. None of the variants carries
/// key material, a socket path, or a certificate subject.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SpiffeSourceError {
    /// Configuration that could never work (bad SPIFFE ID, relative socket
    /// path, URI where a path was required, missing variable).
    #[error("spiffe source configuration: {0}")]
    Config(String),
    /// The selected SVID's leaf violates the X509-SVID profile.
    #[error("x509-svid profile: {0}")]
    Profile(#[from] SvidProfileError),
    /// The authoritative snapshot does not carry the configured SPIFFE ID.
    /// "First returned" is never a substitute.
    #[error("workload api issued {offered} svid(s), none for the configured identity")]
    NotIssued {
        /// How many SVIDs the snapshot carried.
        offered: usize,
    },
    /// The snapshot carries the configured SPIFFE ID more than once. Two
    /// keys for one identity is a selection the source refuses to make.
    #[error("workload api issued the configured identity {count} times")]
    Ambiguous {
        /// How many SVIDs matched.
        count: usize,
    },
    /// The snapshot carries no bundle for the selected SVID's trust domain.
    #[error("workload api snapshot carries no bundle for trust domain {trust_domain}")]
    BundleMissing {
        /// The trust domain the selected SVID presented.
        trust_domain: String,
    },
    /// A bundle certificate could not be parsed or is not a CA.
    #[error("bundle for trust domain {trust_domain} is unusable: {detail}")]
    BundleMalformed {
        /// The trust domain the bundle was keyed by.
        trust_domain: String,
        /// Non-secret detail.
        detail: String,
    },
    /// The Workload API connection or stream failed.
    #[error("workload api transport: {0}")]
    Transport(String),
}

impl SpiffeSourceError {
    /// Stable machine code for logs and status (`snake_case`).
    #[must_use]
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Config(_) => "spiffe_config",
            Self::Profile(_) => "svid_profile",
            Self::NotIssued { .. } => "svid_not_issued",
            Self::Ambiguous { .. } => "svid_ambiguous",
            Self::BundleMissing { .. } => "bundle_missing",
            Self::BundleMalformed { .. } => "bundle_malformed",
            Self::Transport(_) => "workload_api_transport",
        }
    }

    /// The [`TransportError`] the generation manager is told about.
    #[must_use]
    pub fn to_transport_error(&self) -> TransportError {
        match self {
            Self::Config(detail) => TransportError::malformed(detail.clone()),
            Self::Profile(e) => TransportError::malformed(format!("x509-svid profile: {e}")),
            Self::NotIssued { .. } => TransportError::IdentityMissing,
            Self::Ambiguous { count } => {
                TransportError::malformed(format!("configured identity issued {count} times"))
            }
            Self::BundleMissing { .. } => TransportError::TrustUnknown,
            Self::BundleMalformed { detail, .. } => {
                TransportError::malformed(format!("bundle: {detail}"))
            }
            Self::Transport(_) => TransportError::SourceUnsupported,
        }
    }

    /// True when a snapshot with this error is an authoritative withdrawal
    /// (apply immediately) rather than a malformed update (keep the current
    /// generation within its own bounds).
    #[must_use]
    pub const fn is_withdrawal(&self) -> bool {
        matches!(self, Self::NotIssued { .. } | Self::BundleMissing { .. })
    }
}

impl From<SpiffeSourceError> for TransportError {
    fn from(value: SpiffeSourceError) -> Self {
        value.to_transport_error()
    }
}
